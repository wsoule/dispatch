import { openSqliteDb, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, expect, it } from 'bun:test';
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
let draftId: string;
let gateId: string;
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

// A gated draft, then a restart with a2a.db refused as a newer schema.
beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-guards-down-home-')));
  process.env.DISPATCH_HOME = home;
  root = initGitRepo('a2a-guards-down-');
  TaskStore.init(root);
  const first = await boot();
  const { caller } = await approvedClient('acme');
  const opened = await first.a2a.port!.open(caller, {
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
  const row = first.a2a.store!.getTask(opened.taskId)!;
  draftId = row.dispatchTask!;
  gateId = row.gate!;
  await first.stop();
  handle = null;
  const raw = openSqliteDb(join(runsDir(root), 'a2a.db'));
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  const second = await boot();
  expect(second.a2a.store).toBeNull();
  expect(second.a2a.status().error).toContain('newer schema');
});

afterEach(async () => {
  await handle?.stop();
  handle = null;
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

it('still refuses to dispatch or move a gated draft when a2a.db is refused', async () => {
  const h = handle!;
  await expect(h.orchestrator.dispatch(draftId, 'fake')).rejects.toThrow(
    /A2A proposal/
  );
  // Thrown, not rejected: dispatchAuxRun's guards run synchronously.
  expect(() =>
    h.orchestrator.dispatchAuxRun({
      taskId: draftId,
      kind: 'execute',
      head: 'HEAD',
      buildPrompt: () => 'x',
      operator: null,
    })
  ).toThrow(/A2A proposal/);
  const res = await rawFetch(`${base}/api/tasks/${draftId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${h.tokens.agentToken}`, ...json },
    body: JSON.stringify({ status: 'ready' }),
  });
  expect(res.status).toBe(409);
  expect(
    (
      await fetch(`${base}/api/tasks/${draftId}/fanout`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ variants: ['fake'] }),
      })
    ).status
  ).toBe(409);
  expect(h.orchestrator.list()).toEqual([]);
});

it('treats a handed-off task as A2A provenance even with a2a.db refused', () => {
  expect(handle!.a2a.taskOrigin(draftId)).toBe('a2a');
  const plain = TaskStore.init(root).create({ title: 'local work' });
  expect(handle!.a2a.taskOrigin(plain.meta.id)).toBeNull();
});

it('still reverts a hand edit, and the gate stays open', async () => {
  const doc = TaskStore.init(root); // the same task files the daemon reads
  doc.update(draftId, { status: 'ready' });
  expect(handle!.a2a.recheckProposals()).toBe(1);
  expect(doc.get(draftId)?.meta.status).toBe('draft');
  expect(await (await fetch(`${base}/api/decisions/open`)).text()).toContain(
    gateId
  );
});

it('holds a draft whose gate closed without the system accepting it', async () => {
  const h = handle!;
  await h.messaging.engine.reply(
    gateId,
    { body: '', choice: 'approve' },
    { address: 'human:wyat', canDecide: true }
  );
  TaskStore.init(root).update(draftId, { status: 'ready' });
  await expect(h.orchestrator.dispatch(draftId, 'fake')).rejects.toThrow(
    /has not approved/
  );
});
