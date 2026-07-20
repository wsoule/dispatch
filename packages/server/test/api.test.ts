import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';

// `Response.json()` types as `Promise<unknown>` under this repo's strict,
// DOM-less tsconfig; these tests assert on arbitrary response shapes (health,
// error bodies, task docs), so a thin `any` escape hatch here is simpler than
// hand-rolling a response type per endpoint.
function json(res: Response): Promise<any> {
  return res.json();
}

let root: string;
let handle: ServerHandle;
let baseUrl: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-server-'));
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
  });
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
});

describe('GET /api/health', () => {
  it('reports ok and a version string', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
  });
});

describe('GET /api/config', () => {
  it('returns the default DispatchConfig', async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.statuses).toEqual([
      'backlog',
      'todo',
      'in-progress',
      'in-review',
      'done',
      'cancelled',
    ]);
    expect(body.autoCommit).toBe(false);
  });

  it('returns 422 with no stack trace when config.yml is corrupt', async () => {
    writeFileSync(join(root, '.dispatch/config.yml'), 'statuses: [a\n');
    const res = await fetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error).toMatch(/invalid \.dispatch\/config\.yml/);
    expect(body.stack).toBeUndefined();
  });
});

describe('task CRUD round-trip', () => {
  it('creates, fetches, lists, and updates a task via HTTP', async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Fix login', priority: 'high' }),
    });
    expect(createRes.status).toBe(201);
    const created = await json(createRes);
    expect(created.meta.title).toBe('Fix login');
    expect(created.meta.status).toBe('todo');

    const getRes = await fetch(`${baseUrl}/api/tasks/${created.meta.id}`);
    expect(getRes.status).toBe(200);
    expect((await json(getRes)).meta.id).toBe(created.meta.id);

    const listRes = await fetch(`${baseUrl}/api/tasks`);
    const list = await json(listRes);
    expect(list).toHaveLength(1);
    expect(list[0].meta.id).toBe(created.meta.id);

    const patchRes = await fetch(`${baseUrl}/api/tasks/${created.meta.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'in-progress' }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await json(patchRes);
    expect(patched.meta.status).toBe('in-progress');

    const afterPatch = await json(
      await fetch(`${baseUrl}/api/tasks/${created.meta.id}`)
    );
    expect(afterPatch.meta.status).toBe('in-progress');
  });
});

describe('filter + ready queries', () => {
  it('filters by status/kind/parent and computes readyTasks', async () => {
    const epic = await json(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Epic', kind: 'epic' }),
      })
    );
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Child', parent: epic.meta.id }),
    });
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Backlogged', status: 'backlog' }),
    });

    const byKind = await json(await fetch(`${baseUrl}/api/tasks?kind=epic`));
    expect(byKind).toHaveLength(1);

    const byParent = await json(
      await fetch(`${baseUrl}/api/tasks?parent=${epic.meta.id}`)
    );
    expect(byParent).toHaveLength(1);
    expect(byParent[0].meta.title).toBe('Child');

    const byStatus = await json(
      await fetch(`${baseUrl}/api/tasks?status=backlog`)
    );
    expect(byStatus).toHaveLength(1);
    expect(byStatus[0].meta.title).toBe('Backlogged');

    const ready = await json(await fetch(`${baseUrl}/api/tasks/ready`));
    // "Child" is a task, status=todo, no blockers -> ready. "Backlogged" is
    // status=backlog -> not ready. Epic is kind=epic -> not ready.
    expect(ready.map((t: { meta: { title: string } }) => t.meta.title)).toEqual(
      ['Child']
    );
  });
});

describe('error paths', () => {
  it('404s a missing task id', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/t-000000`);
    expect(res.status).toBe(404);
    expect((await json(res)).error).toMatch(/task not found/);
  });

  it('404s patching a missing task id', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/t-000000`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    expect(res.status).toBe(404);
  });

  it('400s creating a task with an empty title', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/title/);
  });

  it('400s creating a task with an invalid status', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'X', status: 'nope' }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toBe(
      'invalid status: nope (expected backlog|todo|in-progress|in-review|done|cancelled)'
    );
  });

  it('400s patching a task with an invalid status', async () => {
    const created = await json(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'X' }),
      })
    );
    const res = await fetch(`${baseUrl}/api/tasks/${created.meta.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'nope' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('WebSocket task.changed broadcast', () => {
  it('sends hello on open, then task.changed after a POST', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
    const messages: unknown[] = [];
    const nextMessage = () =>
      new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('WS message timeout')),
          2000
        );
        ws.addEventListener(
          'message',
          (ev) => {
            clearTimeout(timer);
            const parsed = JSON.parse(ev.data as string);
            messages.push(parsed);
            resolve(parsed);
          },
          { once: true }
        );
      });

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WS open failed')));
    });

    expect(await nextMessage()).toEqual({
      type: 'hello',
      version: expect.any(String),
    });

    const changed = nextMessage();
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Triggers broadcast' }),
    });
    expect(await changed).toEqual({ type: 'task.changed' });

    ws.close();
  });
});
