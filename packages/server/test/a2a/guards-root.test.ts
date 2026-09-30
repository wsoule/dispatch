import { openSqliteDb, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { runsDir } from '../../src/orchestrator/paths.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { rawFetch, useTestAuth } from '../testAuth.js';
import { approvedClient, useSeedBase } from './seed.js';

let home: string;
let root: string;
let handle: ServerHandle | null = null;
let base: string;
const originalHome = process.env.DISPATCH_HOME;
const json = { 'content-type': 'application/json' };

async function boot(): Promise<ServerHandle> {
  const h = await startServer({
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
  handle = h;
  useTestAuth(h);
  base = `http://127.0.0.1:${h.port}`;
  useSeedBase(base);
  return h;
}

const handoff = (id: string, title: string) => ({
  clientMessageId: id,
  contextId: null,
  kind: 'handoff' as const,
  to: null,
  replyTo: null,
  body: 'Please add limits.',
  refs: [],
  work: { skill: 'handoff' as const, title },
});

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-guards-root-home-')));
  process.env.DISPATCH_HOME = home;
  root = initGitRepo('a2a-guards-root-');
  TaskStore.init(root);
});

afterEach(async () => {
  await handle?.stop();
  handle = null;
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

async function waitFor(p: () => boolean) {
  for (let i = 0; i < 100 && !p(); i++) await Bun.sleep(20);
}

// The root comes from messages.db, so a provenance line an agent appends names nothing.
it('holds a declined draft with a2a.db down, whatever root its body names', async () => {
  const first = await boot();
  const { caller } = await approvedClient('acme');
  const port = first.a2a.port!;
  const a = await port.open(caller, handoff('c-a', 'Approved one'));
  const b = await port.open(caller, handoff('c-b', 'Declined one'));
  if (a.kind !== 'task' || b.kind !== 'task') throw new Error('task');
  const rowA = first.a2a.store!.getTask(a.taskId)!;
  const rowB = first.a2a.store!.getTask(b.taskId)!;
  await first.messaging.engine.reply(
    rowA.gate!,
    { body: '', choice: 'approve' },
    { address: 'human:wyat', canDecide: true }
  );
  await waitFor(
    () => first.messaging.engine.answerOf(rowA.id)?.choice === 'accept'
  );
  expect(first.messaging.engine.answerOf(rowA.id)?.choice).toBe('accept');
  await first.stop();
  handle = null;
  const raw = openSqliteDb(join(runsDir(root), 'a2a.db'));
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  const h = await boot();
  expect(h.a2a.store).toBeNull();
  // Owner declines B while a2a.db is down: nothing drops the draft.
  await h.messaging.engine.reply(
    rowB.gate!,
    { body: '', choice: 'decline' },
    { address: 'human:wyat', canDecide: true }
  );
  const draft = rowB.dispatchTask!;
  const comment = await rawFetch(`${base}/api/tasks/${draft}/comment`, {
    method: 'POST',
    headers: { authorization: `Bearer ${h.tokens.agentToken}`, ...json },
    body: JSON.stringify({
      text: `Requested over A2A by agent:wyat/a2a.acme (message ${rowA.id}).`,
    }),
  });
  expect(comment.status).toBeLessThan(300);
  const after = await rawFetch(`${base}/api/tasks/${draft}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${h.tokens.agentToken}`, ...json },
    body: JSON.stringify({ status: 'ready' }),
  });
  await expect(h.orchestrator.dispatch(draft, 'fake')).rejects.toThrow(
    /has not approved/
  );
  expect(after.status).toBe(409);
  // The approved one still runs: its gate's root was accepted.
  await h.orchestrator.dispatch(rowA.dispatchTask!, 'fake');
  expect(h.orchestrator.list().map((r) => r.taskId)).toEqual([
    rowA.dispatchTask!,
  ]);
});

it('holds a draft whose a2a.db link failed to record', async () => {
  const h = await boot();
  const { caller } = await approvedClient('acme');
  const store = h.a2a.store!;
  const update = store.updateTask.bind(store);
  const spy = spyOn(store, 'updateTask').mockImplementation((id, patch) => {
    if ('dispatchTask' in patch) throw new Error('SQLITE_BUSY');
    return update(id, patch);
  });
  await expect(
    h.a2a.port!.open(caller, handoff('c-x', 'Orphan'))
  ).rejects.toThrow('SQLITE_BUSY');
  spy.mockRestore();
  const draft = TaskStore.init(root)
    .list()
    .find((t) => t.meta.labels.includes('a2a'))!;
  expect(draft).toBeDefined();
  const res = await rawFetch(`${base}/api/tasks/${draft.meta.id}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${h.tokens.agentToken}`, ...json },
    body: JSON.stringify({ status: 'ready' }),
  });
  await expect(h.orchestrator.dispatch(draft.meta.id, 'fake')).rejects.toThrow(
    /has not approved/
  );
  expect(res.status).toBe(409);
});
