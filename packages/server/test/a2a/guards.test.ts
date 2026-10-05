import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { waitFor } from '../messaging/harness.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { rawFetch, useTestAuth } from '../testAuth.js';
import { approvedClient, useSeedBase } from './seed.js';

let home: string;
let root: string;
let handle: ServerHandle;
let base: string;
let owner: string;
let draftId: string;
let gateId: string;
const originalHome = process.env.DISPATCH_HOME;
const json = { 'content-type': 'application/json' };

// A daemon with an approved client whose handoff is open, so the draft is gated.
beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-guards-home-')));
  process.env.DISPATCH_HOME = home;
  root = initGitRepo('a2a-guards-');
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    webDistDir: null,
    registerExecutors: (o) =>
      o.registerExecutor(
        'fake',
        new FakeExecutor({ steps: [], finish: { state: 'finished' } })
      ),
  });
  useTestAuth(handle);
  base = `http://127.0.0.1:${handle.port}`;
  useSeedBase(base);
  owner = handle.a2a.port!.deps.ownerRef;
  const { caller } = await approvedClient('acme');
  const opened = await handle.a2a.port!.open(caller, {
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
  const row = handle.a2a.store!.getTask(opened.taskId)!;
  draftId = row.dispatchTask!;
  gateId = row.gate!;
});

afterEach(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const draft = () => handle.a2a.port!.deps.tasks.get(draftId);
const patchAs = (token: string, body: Record<string, unknown>) =>
  rawFetch(`${base}/api/tasks/${draftId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, ...json },
    body: JSON.stringify(body),
  });

it('refuses an MCP task_save status change (the shared agent token) and keeps the gate open', async () => {
  const res = await patchAs(handle.tokens.agentToken, { status: 'ready' });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toContain(
    'A2A proposal awaiting the owner'
  );
  expect(handle.a2a.port?.deps.engine.answerOf(gateId)).toBeNull();
  expect(draft()?.meta.status).toBe('draft');
});

it('treats a decide-tier status change as the owner answering the gate', async () => {
  const lead = handle.team.teammates.issue('ada', 'decide');
  const res = await patchAs(lead, { status: 'ready' });
  expect(res.status).toBe(200);
  expect(handle.a2a.port?.deps.engine.answerOf(gateId)).toMatchObject({
    choice: 'approve',
    from: 'human:ada',
  });
});

it('reads a decide-tier move to Dropped as declining the proposal', async () => {
  const lead = handle.team.teammates.issue('ada', 'decide');
  expect((await patchAs(lead, { status: 'dropped' })).status).toBe(200);
  expect(handle.a2a.port?.deps.engine.answerOf(gateId)).toMatchObject({
    choice: 'decline',
  });
  expect(draft()?.meta.status).toBe('dropped');
});

it('refuses dispatch of a gated draft through createRun and fan-out', async () => {
  expect(
    (
      await fetch(`${base}/api/tasks/${draftId}/runs`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ executor: 'fake' }),
      })
    ).status
  ).toBe(409);
  expect(
    (
      await fetch(`${base}/api/tasks/${draftId}/fanout`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ variants: ['fake'] }),
      })
    ).status
  ).toBe(409);
  await expect(handle.orchestrator.dispatch(draftId, 'fake')).rejects.toThrow(
    /A2A proposal/
  );
  expect(handle.orchestrator.list()).toEqual([]);
});

it('puts a draft moved outside the routes back and tells the owner once', async () => {
  // The daemon's own store port, written with no route in between: what the
  // MCP writing the store with no daemon, a hand edit or board sync amounts to.
  const tasks = handle.a2a.port!.deps.tasks;
  const notices = () =>
    handle.a2a
      .port!.deps.engine.inbox(owner)
      .filter(
        ({ message }) =>
          message.kind === 'notice' && message.body.includes(draftId)
      );
  tasks.update(draftId, { status: 'ready' });
  expect(handle.a2a.recheckProposals()).toBe(1);
  expect(tasks.get(draftId)?.meta.status).toBe('draft');
  expect(tasks.get(draftId)?.body).toContain(
    'reverted: A2A proposal awaits the owner'
  );
  expect(handle.a2a.port?.deps.engine.answerOf(gateId)).toBeNull();
  // A second move is put back too, but the owner has already been told.
  tasks.update(draftId, { status: 'ready' });
  expect(handle.a2a.recheckProposals()).toBe(1);
  expect(handle.a2a.recheckProposals()).toBe(0);
  await waitFor(() => notices().length > 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(notices()).toHaveLength(1);
});

it('after approval, refuses a below-decide caller lowering the risk', async () => {
  const lead = handle.team.teammates.issue('ada', 'decide');
  expect((await patchAs(lead, { status: 'ready' })).status).toBe(200);
  const res = await patchAs(handle.tokens.agentToken, { risk: 'routine' });
  expect(res.status).toBe(403);
  expect(draft()?.meta.risk).toBe('critical');
  expect((await patchAs(lead, { risk: 'routine' })).status).toBe(200);
});

// Thrown, not rejected: dispatchAuxRun's guards run synchronously.
it('refuses an aux execute run of a gated draft (the FixLoop path), and every other aux kind', () => {
  for (const kind of ['execute', 'review', 'verify'] as const) {
    expect(() =>
      handle.orchestrator.dispatchAuxRun({
        taskId: draftId,
        kind,
        head: 'HEAD',
        buildPrompt: () => 'x',
        operator: null,
      })
    ).toThrow(/A2A proposal/);
  }
  expect(handle.orchestrator.list()).toEqual([]);
});

it('reverts on the next task.changed without being asked', async () => {
  const tasks = handle.a2a.port!.deps.tasks;
  tasks.update(draftId, { status: 'ready' }); // no route, so no broadcast yet
  // Any task.changed will do (a hand edit's comes from the file watcher);
  // POST /api/tasks sends one.
  expect(
    (
      await fetch(`${base}/api/tasks`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ title: 'unrelated' }),
      })
    ).status
  ).toBe(201);
  await waitFor(() => tasks.get(draftId)?.meta.status === 'draft');
  expect(handle.a2a.port?.deps.engine.answerOf(gateId)).toBeNull();
});
