import { describe, expect, it } from 'bun:test';

import { approvedClient, useSeedBase } from '../a2a/seed.js';
import { useTestAuth } from '../testAuth.js';
import type { World } from './world.js';
import { call, liveRun, startRun, useWorld } from './world.js';

// XH-R2: A2A provenance follows lineage. A task an A2A-origin run creates,
// edits or dispatches is A2A-origin too, so its runs act for no one and read
// what an A2A run reads; and no other run may message an A2A run.

const world = useWorld();

// An approved client handoff's task, dispatched by the owner: an A2A run.
async function a2aRun(
  w: World
): Promise<{ taskId: string; runId: string; runToken: string }> {
  useTestAuth(w.handle);
  useSeedBase(w.base);
  const { caller } = await approvedClient('acme');
  const opened = await w.handle.a2a.port!.open(caller, {
    clientMessageId: 'c-h1',
    contextId: null,
    kind: 'handoff',
    to: null,
    replyTo: null,
    body: 'Please add limits.',
    refs: [],
    work: { skill: 'handoff', title: 'Rate-limit uploads' },
  });
  if (opened.kind !== 'task') throw new Error('expected a task');
  const row = w.handle.a2a.store!.getTask(opened.taskId)!;
  await w.handle.messaging.engine.reply(
    row.gate!,
    { body: '', choice: 'approve' },
    { address: 'human:test', canDecide: true }
  );
  const taskId = row.dispatchTask!;
  const run = await startRun(w, w.app, taskId);
  expect(run.meta.operator ?? null).toBeNull();
  return { taskId, runId: run.runId, runToken: run.runToken };
}

const origin = (w: World, taskId: string) => w.handle.a2a.taskOrigin(taskId);

describe('A2A lineage', () => {
  it('a task an A2A run creates is A2A-origin, and so are its runs', async () => {
    const w = world();
    const a2a = await a2aRun(w);
    const child = await call(w, a2a.runToken, 'POST', '/api/tasks', {
      title: 'helper: recite project memory',
    });
    expect(child.status).toBe(201);
    const childId = child.json.meta.id as string;
    expect(origin(w, childId)).toBe('a2a');

    // Even the owner's dispatch of it acts for no one.
    const run = await startRun(w, w.app, childId);
    expect(run.meta.operator ?? null).toBeNull();
  });

  it('a task an A2A run edits or dispatches becomes A2A-origin', async () => {
    const w = world();
    const edited = await call(w, w.app, 'POST', '/api/tasks', {
      title: 'owner task',
    });
    const dispatched = await call(w, w.app, 'POST', '/api/tasks', {
      title: 'another owner task',
    });
    const a2a = await a2aRun(w);
    expect(origin(w, edited.json.meta.id)).toBeNull();

    const patch = await call(
      w,
      a2a.runToken,
      'PATCH',
      `/api/tasks/${edited.json.meta.id}`,
      { body: 'rewritten by an A2A run\n' }
    );
    expect(patch.status).toBe(200);
    expect(origin(w, edited.json.meta.id)).toBe('a2a');

    const run = await startRun(w, a2a.runToken, dispatched.json.meta.id);
    expect(origin(w, dispatched.json.meta.id)).toBe('a2a');
    expect(run.meta.operator ?? null).toBeNull();
  });

  it("an ordinary run's tasks stay the project's own", async () => {
    const w = world();
    const run = await liveRun(w, w.app, 'owner work');
    const child = await call(w, run.runToken, 'POST', '/api/tasks', {
      title: 'ordinary child',
    });
    expect(origin(w, child.json.meta.id)).toBeNull();
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
