import { TaskStore } from '@dispatch/core';
import type { Message } from '@dispatch/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GateHandlers } from '../../src/messaging/gates.js';
import { DaemonMessagingHost } from '../../src/messaging/host.js';
import type { DaemonHostDeps } from '../../src/messaging/host.js';
import type { RunMeta } from '../../src/orchestrator/types.js';

// A message the tests don't care about the content of; only `id`/`from` vary.
function stubMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm-00000000000000000000000000',
    thread: 'm-00000000000000000000000000',
    replyTo: null,
    from: 'human:wyat',
    to: ['task:t-abc123'],
    kind: 'message',
    body: 'hello',
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-09-23T10:00:00.000Z',
    ...overrides,
  };
}

let root: string;
let store: TaskStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-host-test-'));
  store = TaskStore.init(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Builds a host with a hand-rolled orchestrator stub; each test overrides
// only the methods it exercises.
function makeHost(
  orchestratorOverrides: Partial<DaemonHostDeps['orchestrator']> = {}
): { host: DaemonMessagingHost; calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {
    deliverToRun: [],
    notifyRun: [],
    dispatchOrResume: [],
  };
  const orchestrator: DaemonHostDeps['orchestrator'] = {
    liveRunIdForTask: () => null,
    isRunLive: () => false,
    taskIdOfRun: () => null,
    deliverToRun: (runId, text, from) => {
      calls.deliverToRun.push([runId, text, from]);
    },
    notifyRun: (runId, digest) => {
      calls.notifyRun.push([runId, digest]);
    },
    dispatchOrResume: async (taskId, request) => {
      calls.dispatchOrResume.push([taskId, request]);
      throw new Error('not implemented in this stub');
    },
    ...orchestratorOverrides,
  };
  const host = new DaemonMessagingHost({
    rootDir: root,
    orchestrator,
    store,
    ownerRef: 'human:wyat',
    gates: new GateHandlers(),
    onHumanMessage: () => {},
  });
  return { host, calls };
}

describe('DaemonMessagingHost.push', () => {
  it('marks a human sender as human: true', async () => {
    const { host, calls } = makeHost();
    const message = stubMessage({ from: 'human:wyat', id: 'm-111' });
    await host.push('r-000001', 'rendered text', message);
    expect(calls.deliverToRun).toEqual([
      [
        'r-000001',
        'rendered text',
        { label: 'human:wyat', messageId: 'm-111', human: true },
      ],
    ]);
  });

  it('marks a run sender as human: false', async () => {
    const { host, calls } = makeHost();
    const message = stubMessage({ from: 'run:r-000002', id: 'm-222' });
    await host.push('r-000001', 'rendered text', message);
    expect(calls.deliverToRun).toEqual([
      [
        'r-000001',
        'rendered text',
        { label: 'run:r-000002', messageId: 'm-222', human: false },
      ],
    ]);
  });
});

describe('DaemonMessagingHost.decide', () => {
  it('denies waking an epic', () => {
    const epic = store.create({ title: 'An epic', kind: 'epic' });
    const { host } = makeHost();
    expect(
      host.decide({
        type: 'wake',
        target: `task:${epic.meta.id}`,
        message: stubMessage(),
      })
    ).toBe('deny');
  });

  it('denies waking a landed task', () => {
    const task = store.create({ title: 'Done work' });
    store.update(task.meta.id, { status: 'landed' });
    const { host } = makeHost();
    expect(
      host.decide({
        type: 'wake',
        target: `task:${task.meta.id}`,
        message: stubMessage(),
      })
    ).toBe('deny');
  });

  it('asks at the default rung (1)', () => {
    const task = store.create({ title: 'Some work' });
    const { host } = makeHost();
    expect(
      host.decide({
        type: 'wake',
        target: `task:${task.meta.id}`,
        message: stubMessage(),
      })
    ).toBe('ask');
  });

  it('allows once policy rung 3 is configured (wake is a rung-3 gate)', () => {
    const task = store.create({ title: 'Some work' });
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'policy:\n  rung: 3\n'
    );
    const { host } = makeHost();
    expect(
      host.decide({
        type: 'wake',
        target: `task:${task.meta.id}`,
        message: stubMessage(),
      })
    ).toBe('allow');
  });
});

describe('DaemonMessagingHost.implicitMembers', () => {
  it("returns only the epic's own children", () => {
    const epic = store.create({ title: 'Epic', kind: 'epic' });
    const other = store.create({ title: 'Other epic', kind: 'epic' });
    const child1 = store.create({ title: 'Child 1' });
    store.update(child1.meta.id, { parent: epic.meta.id });
    const child2 = store.create({ title: 'Child 2' });
    store.update(child2.meta.id, { parent: epic.meta.id });
    const stray = store.create({ title: 'Not a child' });
    store.update(stray.meta.id, { parent: other.meta.id });

    const { host } = makeHost();
    const members = host.implicitMembers(`epic/${epic.meta.id}`);
    expect(new Set(members)).toEqual(
      new Set([`task:${child1.meta.id}`, `task:${child2.meta.id}`])
    );
  });

  it('returns nothing for a non-epic channel', () => {
    const { host } = makeHost();
    expect(host.implicitMembers('general')).toEqual([]);
  });
});

describe('DaemonMessagingHost.wake', () => {
  it('returns { ok: false, reason } when dispatchOrResume throws', async () => {
    const { host } = makeHost({
      dispatchOrResume: async () => {
        throw new Error('task already has a live run: r-000001');
      },
    });
    const result = await host.wake('task:t-abc123', stubMessage());
    expect(result).toEqual({
      ok: false,
      reason: 'task already has a live run: r-000001',
    });
  });

  it('returns { ok: true, runId } on success', async () => {
    const { host } = makeHost({
      dispatchOrResume: async () => ({ id: 'r-000009' }) as RunMeta,
    });
    const result = await host.wake('task:t-abc123', stubMessage());
    expect(result).toEqual({ ok: true, runId: 'r-000009' });
  });

  it('refuses a non-task target', async () => {
    const { host } = makeHost();
    const result = await host.wake('human:wyat', stubMessage());
    expect(result.ok).toBe(false);
  });
});
