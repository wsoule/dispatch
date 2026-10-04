import { expect } from 'bun:test';

import { approvedClient, useSeedBase } from '../a2a/seed.js';
import { useTestAuth } from '../testAuth.js';
import type { World } from './world.js';
import { startRun } from './world.js';

// A2A fixtures for the auth suites: a client's approved handoff, and the
// owner's run of it, which is an A2A-origin run.

// A client's handoff, approved by the owner; returns its task.
export async function handoff(
  w: World,
  client: string,
  body: string,
  title: string
): Promise<string> {
  useTestAuth(w.handle);
  useSeedBase(w.base);
  const { caller } = await approvedClient(client);
  const opened = await w.handle.a2a.port!.open(caller, {
    clientMessageId: `c-${client}`,
    contextId: null,
    kind: 'handoff',
    to: null,
    replyTo: null,
    body,
    refs: [],
    work: { skill: 'handoff', title },
  });
  if (opened.kind !== 'task') throw new Error('expected a task');
  const row = w.handle.a2a.store!.getTask(opened.taskId)!;
  await w.handle.messaging.engine.reply(
    row.gate!,
    { body: '', choice: 'approve' },
    { address: 'human:test', canDecide: true }
  );
  return row.dispatchTask!;
}

// An approved client handoff's task, dispatched by the owner: an A2A run.
export async function a2aRun(
  w: World
): Promise<{ taskId: string; runId: string; runToken: string }> {
  const taskId = await handoff(
    w,
    'acme',
    'Please add limits.',
    'Rate-limit uploads'
  );
  const run = await startRun(w, w.app, taskId);
  expect(run.meta.operator ?? null).toBeNull();
  return { taskId, runId: run.runId, runToken: run.runToken };
}
