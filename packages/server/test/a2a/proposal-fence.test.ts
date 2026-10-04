import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { rawFetch, useTestAuth } from '../testAuth.js';
import { approvedClient, useSeedBase } from './seed.js';

let home: string;
let root: string;
let handle: ServerHandle;
const originalHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-fence-home-')));
  process.env.DISPATCH_HOME = home;
  root = initGitRepo('a2a-fence-');
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    webDistDir: null,
  });
  useTestAuth(handle);
  useSeedBase(`http://127.0.0.1:${handle.port}`);
});
afterEach(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// A client's handoff, its draft waiting on the owner's proposal gate.
async function proposedDraft(): Promise<string> {
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
  return handle.a2a.store!.getTask(opened.taskId)!.dispatchTask!;
}

// As the shared agent token, which never decides.
function asAgent(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${handle.tokens.agentToken}`);
  return rawFetch(`http://127.0.0.1:${handle.port}/api/tasks/${path}`, {
    ...init,
    headers,
  });
}

const json = { 'content-type': 'application/json' };

it('refuses amend, comment, attachment and patch on a proposed A2A draft below decide tier', async () => {
  const id = await proposedDraft();
  const form = new FormData();
  form.append('files', new File(['x'], 'note.txt'));
  const writes: [string, RequestInit][] = [
    [
      `${id}/amend`,
      {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ overrides: 'Do more', reason: 'because' }),
      },
    ],
    [
      `${id}/comments`,
      { method: 'POST', headers: json, body: JSON.stringify({ body: 'hi' }) },
    ],
    [`${id}/attachments`, { method: 'POST', body: form }],
    [
      id,
      {
        method: 'PATCH',
        headers: json,
        body: JSON.stringify({ title: 'Something else' }),
      },
    ],
  ];
  for (const [path, init] of writes) {
    const res = await asAgent(path, init);
    expect({ path, status: res.status }).toEqual({ path, status: 409 });
  }
  // The owner may still write while the proposal is open.
  const owner = await fetch(
    `http://127.0.0.1:${handle.port}/api/tasks/${id}/comments`,
    { method: 'POST', headers: json, body: JSON.stringify({ body: 'ok' }) }
  );
  expect(owner.status).toBeLessThan(300);
});

it('needs the decide tier to re-parent an A2A task, proposal or not', async () => {
  const id = await proposedDraft();
  const gate = handle.a2a.store!.taskForDispatchTask(id)!.gate!;
  await handle.messaging.engine.reply(
    gate,
    { body: '', choice: 'approve' },
    { address: 'human:test', canDecide: true }
  );
  const epic = (await (
    await fetch(`http://127.0.0.1:${handle.port}/api/tasks`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ title: 'An epic', kind: 'epic' }),
    })
  ).json()) as { meta: { id: string } };
  const res = await asAgent(id, {
    method: 'PATCH',
    headers: json,
    body: JSON.stringify({ parent: epic.meta.id }),
  });
  expect(res.status).toBe(403);
});
