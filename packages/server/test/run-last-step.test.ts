import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { EventBus } from '../src/events.js';
import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { transcriptPath } from '../src/orchestrator/paths.js';
import { Transcript } from '../src/orchestrator/transcript.js';
import type { NormalizedEntry } from '../src/orchestrator/types.js';
import { json } from './json.js';
import { initGitRepo, StallingExecutor } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// RunMeta.lastStep: a live run's current step on every run read, so a window
// opened mid-run shows what each agent is doing before its next log line.

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-last-step-');
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

const tool = (
  toolName: string,
  toolInput: unknown,
  ts: string,
  extra: Partial<NormalizedEntry> = {}
): NormalizedEntry => ({
  ts,
  kind: 'tool',
  toolName,
  toolInput,
  status: 'running',
  ...extra,
});

// A run that logs `entries`, then parks at an approval gate until answered.
function parkedAfter(entries: NormalizedEntry[]): FakeExecutor {
  return new FakeExecutor({
    steps: [
      ...entries.map((entry) => ({ entry })),
      { approval: { requestId: 'go', toolName: 'noop', input: {} } },
    ],
    finish: { state: 'finished', costUsd: 0, turns: 1 },
  });
}

function harness() {
  const store = TaskStore.init(repo);
  const cache = new TaskCache();
  cache.rebuild(store);
  const orchestrator = new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events: new EventBus(),
  });
  return { orchestrator, store };
}

describe('Orchestrator: lastStep', () => {
  it('follows the log as it is written, and is gone once the run ends', async () => {
    const h = harness();
    h.orchestrator.registerExecutor(
      'fake',
      parkedAfter([
        tool('Read', { file_path: 'src/a.ts' }, '2026-09-25T10:00:00.000Z'),
        tool('Bash', { command: 'bun test' }, '2026-09-25T10:00:01.000Z'),
        // Prose, and a sub-agent's own call, say nothing about the run's step.
        { ts: '2026-09-25T10:00:02.000Z', kind: 'assistant', text: 'Hm.' },
        tool('Edit', { file_path: 'x.ts' }, '2026-09-25T10:00:03.000Z', {
          parentToolUseId: 'tu-1',
        }),
      ])
    );
    const task = h.store.create({ title: 'Stepper' });
    const meta = await h.orchestrator.dispatch(task.meta.id, 'fake');
    const current = () => h.orchestrator.getRun(meta.id)?.meta;
    await waitFor(() => current()?.state === 'awaiting-approval');

    expect(current()?.lastStep).toEqual({
      text: 'Running tests',
      at: '2026-09-25T10:00:01.000Z',
    });

    h.orchestrator.approve(meta.id, 'go', { allow: true });
    await waitFor(() => current()?.state === 'finished');
    expect(current()?.lastStep).toBeUndefined();
  });

  it('reads a log written before it was followed once, from its tail', async () => {
    const h = harness();
    h.orchestrator.registerExecutor('stall', new StallingExecutor());
    const task = h.store.create({ title: 'Picked up' });
    const meta = await h.orchestrator.dispatch(task.meta.id, 'stall');
    // Written behind the orchestrator's back, as by a process before this one:
    // well over the tail window of older steps, then the newest.
    const log = new Transcript(transcriptPath(repo, meta.id));
    const padding = 'x'.repeat(2000);
    for (let i = 0; i < 60; i++) {
      log.appendEntry(
        tool('Read', { file_path: `src/old${i}.ts`, padding }, `old-${i}`)
      );
    }
    log.appendEntry(tool('Grep', { pattern: 'needle' }, 'newest'));
    log.appendEntry({ ts: 'after', kind: 'assistant', text: 'Found it.' });

    h.orchestrator.backfillLastSteps();
    const step = () =>
      h.orchestrator.list().find((r) => r.id === meta.id)?.lastStep;
    expect(step()).toEqual({ text: 'Searching for needle', at: 'newest' });

    // Read once: later reads never go back to the log.
    log.appendEntry(tool('Glob', { pattern: '*.md' }, 'unseen'));
    h.orchestrator.backfillLastSteps();
    expect(step()).toEqual({ text: 'Searching for needle', at: 'newest' });
  });

  it('leaves a run with no step yet without one', async () => {
    const h = harness();
    h.orchestrator.registerExecutor('stall', new StallingExecutor());
    const task = h.store.create({ title: 'Quiet' });
    const meta = await h.orchestrator.dispatch(task.meta.id, 'stall');
    h.orchestrator.backfillLastSteps();
    expect(h.orchestrator.getRun(meta.id)?.meta.lastStep).toBeUndefined();
  });
});

describe('GET /api/runs: lastStep', () => {
  let handle: ServerHandle;
  let baseUrl: string;

  beforeEach(async () => {
    TaskStore.init(repo);
    handle = await startServer({
      rootDir: repo,
      port: 0,
      writeDaemonFile: false,
      registerExecutors: (orchestrator) => {
        orchestrator.registerExecutor(
          'fake',
          parkedAfter([
            tool(
              'Edit',
              { file_path: 'src/checkout.ts' },
              '2026-09-25T11:00:00.000Z'
            ),
          ])
        );
      },
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
  });

  it('carries a live run’s step on the list and the detail', async () => {
    const task = await json(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Checkout' }),
      })
    );
    const run = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'fake' }),
      })
    );
    await waitFor(
      async () =>
        (await json(await fetch(`${baseUrl}/api/runs/${run.id}`))).meta
          .state === 'awaiting-approval'
    );
    const step = {
      text: 'Editing src/checkout.ts',
      at: '2026-09-25T11:00:00.000Z',
    };
    const listed = (await json(await fetch(`${baseUrl}/api/runs`))).find(
      (r: { id: string }) => r.id === run.id
    );
    expect(listed.lastStep).toEqual(step);
    const detail = await json(await fetch(`${baseUrl}/api/runs/${run.id}`));
    expect(detail.meta.lastStep).toEqual(step);
  });
});
