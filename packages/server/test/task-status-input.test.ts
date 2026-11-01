import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { json } from './json.js';
import { useTestAuth } from './testAuth.js';

// POST/PATCH /api/tasks and the list filter on a board linked to Linear: none
// of its names is a built-in, and its review status is its dispatched one.
const LINEAR_CONFIG = `statuses:
  - { name: Backlog, type: backlog }
  - { name: Todo, type: unstarted }
  - { name: In Progress, type: started }
  - { name: Done, type: completed }
  - { name: Canceled, type: canceled }
statusRoles:
  ready: Todo
  dispatched: In Progress
  review: In Progress
  landing: null
  landed: Done
  dropped: Canceled
`;

let root: string;
let fakeHome: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-status-input-'));
  TaskStore.init(root);
  writeFileSync(join(root, '.dispatch', 'config.yml'), LINEAR_CONFIG);
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

async function createdStatus(body: Record<string, unknown>): Promise<string> {
  const res = await send('POST', '/api/tasks', { title: 'X', ...body });
  expect(res.status).toBe(201);
  return (await json(res)).meta.status as string;
}

describe('task status input', () => {
  it('stores built-in words as the roles they name', async () => {
    expect(await createdStatus({ status: 'draft' })).toBe('Backlog');
    expect(await createdStatus({ status: 'landed' })).toBe('Done');
    expect(await createdStatus({})).toBe('Todo');
  });

  it('matches board names case-insensitively before the legacy aliases', async () => {
    expect(await createdStatus({ status: 'done' })).toBe('Done');
    expect(await createdStatus({ status: 'in progress' })).toBe('In Progress');
  });

  it('patches through the same resolution', async () => {
    const created = await json(
      await send('POST', '/api/tasks', { title: 'X' })
    );
    const path = `/api/tasks/${created.meta.id}`;
    const res = await send('PATCH', path, { status: 'landed' });
    expect(res.status).toBe(200);
    expect((await json(res)).meta.status).toBe('Done');
  });

  it('refuses a word with no status, naming what was sent', async () => {
    const res = await send('POST', '/api/tasks', {
      title: 'X',
      status: 'shipped',
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe(
      'invalid status: shipped (expected Backlog|Todo|In Progress|Done|Canceled)'
    );
    // No landing role on this board, so the word has nowhere to go.
    const landing = await send('POST', '/api/tasks', {
      title: 'X',
      status: 'landing',
    });
    expect(landing.status).toBe(400);
  });

  it('filters the list by a resolved status', async () => {
    await createdStatus({ status: 'Done' });
    await createdStatus({});
    const res = await fetch(`${baseUrl}/api/tasks?status=landed`);
    const docs = (await json(res)) as { meta: { status: string } }[];
    expect(docs.map((d) => d.meta.status)).toEqual(['Done']);
  });
});
