import { TaskStore } from '@dispatch/core';
import type { TaskDoc } from '@dispatch/core';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

let root: string;
let fakeHome: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-sort-order-'));
  runGitSync(root, ['init', '-b', 'main']);
  runGitSync(root, ['config', 'user.email', 'test@example.com']);
  runGitSync(root, ['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'README.md'), '# test repo\n');
  runGitSync(root, ['add', '-A']);
  runGitSync(root, ['commit', '-m', 'initial commit']);
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function send(method: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

it('takes a milestone’s sort order on create and update, numbers only', async () => {
  const created = await send('POST', '/api/tasks', {
    title: 'Beta',
    kind: 'milestone',
    sortOrder: 2,
  });
  expect(created.status).toBe(201);
  const doc = (await created.json()) as TaskDoc;
  expect(doc.meta.sortOrder).toBe(2);

  const bad = await send('PATCH', `/api/tasks/${doc.meta.id}`, {
    sortOrder: 'first',
  });
  expect(bad.status).toBe(400);
  const moved = await send('PATCH', `/api/tasks/${doc.meta.id}`, {
    sortOrder: -0.5,
  });
  expect(((await moved.json()) as TaskDoc).meta.sortOrder).toBe(-0.5);
  const cleared = await send('PATCH', `/api/tasks/${doc.meta.id}`, {
    sortOrder: null,
  });
  expect(((await cleared.json()) as TaskDoc).meta.sortOrder).toBeNull();
});
