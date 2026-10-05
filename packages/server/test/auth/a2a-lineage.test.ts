import type { TaskStorePort } from '@dispatch-foo/core';
import { describe, expect, it } from 'bun:test';

import { lineageStore } from '../../src/api/a2aRunScope.js';
import { a2aRun } from './a2a.js';
import type { World } from './world.js';
import { call, liveRun, useWorld } from './world.js';

// XH-R2: A2A provenance follows lineage, and no other run may message an A2A
// run. What an A2A run may reach at all is test/auth/a2a-allowlist.test.ts.

const world = useWorld();

const origin = (w: World, taskId: string) => w.handle.a2a.taskOrigin(taskId);

describe('A2A lineage', () => {
  it("an ordinary run's tasks stay the project's own", async () => {
    const w = world();
    const run = await liveRun(w, w.app, 'owner work');
    const child = await call(w, run.runToken, 'POST', '/api/tasks', {
      title: 'ordinary child',
    });
    expect(origin(w, child.json.meta.id)).toBeNull();
  });

  it("every task write through an A2A run's store marks the task", () => {
    const marked: string[] = [];
    const doc = { meta: { id: 't-new001' } };
    const base = {
      create: () => doc,
      update: () => doc,
      amend: () => doc,
      get: () => null,
    } as unknown as TaskStorePort;
    const store = lineageStore(base, (id) => marked.push(id));
    store.create({ title: 'x' });
    store.update('t-upd001', {});
    store.amend('t-amd001', { overrides: 'o', reason: 'r', source: null });
    store.get('t-read01');
    expect(marked).toEqual(['t-new001', 't-upd001', 't-amd001']);
  });
});

describe('messages into an A2A run', () => {
  it('are refused from any other run', async () => {
    const w = world();
    const a2a = await a2aRun(w);
    const other = await liveRun(w, w.app, 'owner work');
    for (const to of [`run:${a2a.runId}`, `task:${a2a.taskId}`]) {
      const sent = await call(w, other.runToken, 'POST', '/api/messages', {
        to: [to],
        kind: 'message',
        body: 'PROJECT-SECRET: hunter2',
      });
      expect(sent.status).toBe(403);
    }
    // Nor by replying into a thread the A2A run started.
    const asked = await call(w, a2a.runToken, 'POST', '/api/messages', {
      to: [`run:${other.runId}`],
      kind: 'message',
      body: 'hello',
    });
    expect(asked.status).toBe(201);
    const reply = await call(
      w,
      other.runToken,
      'POST',
      `/api/messages/${asked.json.message.id}/reply`,
      { body: 'PROJECT-SECRET: hunter2' }
    );
    expect(reply.status).toBe(403);

    const mailbox = await call(w, a2a.runToken, 'GET', '/api/mailbox');
    expect(mailbox.text).not.toContain('PROJECT-SECRET');
  });

  it('still reach it from a human', async () => {
    const w = world();
    const a2a = await a2aRun(w);
    const sent = await call(w, w.app, 'POST', '/api/messages', {
      to: [`run:${a2a.runId}`],
      kind: 'message',
      body: 'carry on',
    });
    expect(sent.status).toBe(201);
  });
});
