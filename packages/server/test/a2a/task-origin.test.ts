import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { waitFor } from '../messaging/harness.js';
import { initGitRepo, StallingExecutor } from '../orchestrator/helpers.js';
import { rawFetch, useTestAuth } from '../testAuth.js';
import { approvedClient, useSeedBase } from './seed.js';

let home: string;
let root: string;
let handle: ServerHandle;
let base: string;
let executor: StallingExecutor;
const originalHome = process.env.DISPATCH_HOME;
const json = { 'content-type': 'application/json' };

// Runs stall once started, so each stays live with its run token minted.
beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-origin-home-')));
  process.env.DISPATCH_HOME = home;
  root = realpathSync(initGitRepo('a2a-origin-'));
  TaskStore.init(root);
  executor = new StallingExecutor();
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    webDistDir: null,
    registerExecutors: (o) => o.registerExecutor('claude', executor),
  });
  useTestAuth(handle);
  base = `http://127.0.0.1:${handle.port}`;
  useSeedBase(base);
});

afterEach(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// A client's handoff, still a gated draft.
async function openHandoff() {
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
  return { row, draft: TaskStore.init(root).get(row.dispatchTask!)! };
}

// Dispatches a task with the app token and waits for its live run's token.
async function liveRun(taskId: string): Promise<{ id: string; token: string }> {
  const before = executor.runTokens.length;
  const res = await fetch(`${base}/api/tasks/${taskId}/runs`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ executor: 'claude' }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  await waitFor(
    () =>
      executor.runTokens.length > before &&
      handle.orchestrator.list().find((r) => r.id === id)?.state === 'running',
    5000
  );
  return { id, token: executor.runTokens[before]! };
}

// An approved handoff the owner relabelled, rewrote and lowered to routine,
// so a2a.db is the only record left that a client asked for it.
async function a2aRun(): Promise<{ id: string; token: string }> {
  const { row, draft } = await openHandoff();
  await handle.messaging.engine.reply(
    row.gate!,
    { body: '', choice: 'approve' },
    { address: handle.a2a.port!.deps.ownerRef, canDecide: true }
  );
  const taskId = draft.meta.id;
  await waitFor(
    () => TaskStore.init(root).get(taskId)?.meta.status === 'ready'
  );
  const res = await fetch(`${base}/api/tasks/${taskId}`, {
    method: 'PATCH',
    headers: json,
    body: JSON.stringify({
      labels: [],
      body: '## Description\n\nRate-limit uploads.\n',
      risk: 'routine',
    }),
  });
  expect(res.status).toBe(200);
  const edited = TaskStore.init(root).get(taskId)!;
  expect(edited.meta.labels).toEqual([]);
  expect(edited.body).not.toContain('over A2A');
  return liveRun(taskId);
}

// Saves as the owner (a null token) or as a run.
async function save(
  token: string | null,
  scope: 'personal' | 'project' | 'team',
  title: string
): Promise<{ status: number; body: { status?: string; gate?: string } }> {
  const res = await (token === null ? fetch : rawFetch)(`${base}/api/memory`, {
    method: 'POST',
    headers:
      token === null ? json : { ...json, authorization: `Bearer ${token}` },
    body: JSON.stringify({ scope, kind: 'fact', title, body: 'b' }),
  });
  const body = (await res.json()) as { status?: string; gate?: string };
  return { status: res.status, body };
}

async function titlesFor(token: string): Promise<string[]> {
  const res = await rawFetch(`${base}/api/memory`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const { entries } = (await res.json()) as { entries: { title: string }[] };
  return entries.map((e) => e.title);
}

it('names a handed-off task as A2A provenance and nothing else', async () => {
  const { draft } = await openHandoff();
  expect(handle.a2a.taskOrigin(draft.meta.id)).toBe('a2a');
  const plain = TaskStore.init(root).create({ title: 'local work' });
  expect(handle.a2a.taskOrigin(plain.meta.id)).toBeNull();
});

it('falls back to the task’s own provenance once a2a.db is closed', async () => {
  const { draft } = await openHandoff();
  const plain = TaskStore.init(root).create({ title: 'local work' });
  await handle.a2a.close();
  expect(handle.a2a.taskOrigin(draft.meta.id)).toBe('a2a');
  expect(handle.a2a.taskOrigin(plain.meta.id)).toBeNull();
});

// An agent's comment that quotes the bridge's provenance line, on a local task.
async function spoofedComment(): Promise<string> {
  const plain = TaskStore.init(root).create({ title: 'local work' });
  const res = await fetch(`${base}/api/tasks/${plain.meta.id}/comment`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      text: 'Requested over A2A by agent:wyat/a2a.acme (message m-fake).',
    }),
  });
  expect(res.status).toBe(200);
  // Comments live in their own store now, so the quote reaches the task only
  // as a comment row.
  const list = await fetch(`${base}/api/tasks/${plain.meta.id}/comments`, {
    headers: json,
  });
  expect(JSON.stringify(await list.json())).toContain('Requested over A2A by');
  return plain.meta.id;
}

describe('A2A origin for memory and docs', () => {
  it('leaves a task ordinary when only a comment quotes the provenance line', async () => {
    const id = await spoofedComment();
    expect(handle.a2a.taskOrigin(id)).toBeNull();
    expect(handle.orchestrator.isA2ATask(id)).toBe(false);
    await handle.a2a.close();
    expect(handle.a2a.taskOrigin(id)).toBeNull();
    expect(handle.orchestrator.isA2ATask(id)).toBe(false);
  });

  it('keeps a real handoff A2A-origin with a2a.db up and down', async () => {
    const { draft } = await openHandoff();
    expect(handle.orchestrator.isA2ATask(draft.meta.id)).toBe(true);
    await handle.a2a.close();
    expect(handle.a2a.taskOrigin(draft.meta.id)).toBe('a2a');
    expect(handle.orchestrator.isA2ATask(draft.meta.id)).toBe(true);
  });
});

describe('memory for a run of a handed-off task', () => {
  it('reads team entries only and acts for no one, on a2a.db’s record alone', async () => {
    for (const scope of ['personal', 'project', 'team'] as const)
      expect((await save(null, scope, `${scope} entry`)).body.status).toBe(
        'active'
      );
    const plain = TaskStore.init(root).create({ title: 'local work' });
    const local = await liveRun(plain.meta.id);
    expect((await titlesFor(local.token)).sort()).toEqual([
      'personal entry',
      'project entry',
      'team entry',
    ]);

    const run = await a2aRun();
    expect(await titlesFor(run.token)).toEqual(['team entry']);
    const meta = handle.orchestrator.list().find((r) => r.id === run.id)!;
    expect(meta.operator).toBeNull();
  });

  it('turns every save into a proposal no rung auto-approves', async () => {
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'policy:\n  rung: 4\n'
    );
    const plain = TaskStore.init(root).create({ title: 'local work' });
    const local = await liveRun(plain.meta.id);
    expect((await save(local.token, 'team', 'local lesson')).body.status).toBe(
      'active'
    );

    const run = await a2aRun();
    expect((await save(run.token, 'personal', 'a personal note')).status).toBe(
      403
    );
    for (const scope of ['project', 'team'] as const) {
      const out = await save(run.token, scope, `${scope} lesson`);
      expect(out.body.status).toBe('proposed');
      const open = await (await fetch(`${base}/api/decisions/open`)).text();
      expect(open).toContain(out.body.gate!);
    }
  });
});
