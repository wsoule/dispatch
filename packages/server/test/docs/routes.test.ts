import { openSqliteDb } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { runsDir } from '../../src/orchestrator/paths.js';
import { initGitRepo, StallingExecutor } from '../orchestrator/helpers.js';
import { rawFetch, useTestAuth, wsUrl } from '../testAuth.js';

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function boot(
  root: string,
  executor: StallingExecutor
): Promise<ServerHandle> {
  const h = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    registerExecutors: (o) => o.registerExecutor('claude', executor),
  });
  useTestAuth(h);
  return h;
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let base: string;
let executor: StallingExecutor;
const originalHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'docs-home-')));
  process.env.DISPATCH_HOME = fakeHome;
  root = realpathSync(initGitRepo('docs-routes-'));
  executor = new StallingExecutor();
  handle = await boot(root, executor);
  base = `http://127.0.0.1:${handle.port}/api`;
});

afterEach(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

async function waitFor(
  check: () => boolean | Promise<boolean>,
  ms = 4000
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

// A request-tier teammate token, issued through the decide-tier route.
async function teammateToken(): Promise<string> {
  const res = await post('/team/tokens', {
    email: 'alice@example.com',
    tier: 'request',
  });
  return (await json<{ token: string }>(res)).token;
}

describe('docs routes', () => {
  it('refuses the shared agent token before any handler runs', async () => {
    const res = await rawFetch(`${base}/docs`, {
      headers: { authorization: `Bearer ${handle.tokens.agentToken}` },
    });
    expect(res.status).toBe(403);
    expect((await json<{ code: string }>(res)).code).toBe(
      'auth_agent_token_forbidden'
    );
    expect((await rawFetch(`${base}/docs`)).status).toBe(401);
  });

  it('creates, reads, edits, lists and deletes a team doc', async () => {
    const created = await post('/docs', {
      title: 'Auth refactor',
      body: '# Auth\n## API\nold\n',
    });
    expect(created.status).toBe(201);
    const made = await json<{
      handle: string;
      rev: { id: string; hash: string };
    }>(created);
    expect(made.handle).toBe('auth-refactor');
    const edited = await post('/docs/auth-refactor/edit', {
      ops: [{ op: 'replace_section', section: 'API', text: 'new' }],
    });
    expect((await json<{ status: string }>(edited)).status).toBe('amended');
    const read = await json<{ text: string; outline: { anchor: string }[] }>(
      await fetch(`${base}/docs/auth-refactor`)
    );
    expect(read.text).toBe('# Auth\n## API\nnew\n');
    expect(read.outline.map((o) => o.anchor)).toEqual(['auth', 'api']);
    const list = await json<{ docs: { handle: string }[]; total: number }>(
      await fetch(`${base}/docs?q=auth`)
    );
    expect(list.docs.map((d) => d.handle)).toEqual(['auth-refactor']);
    const deleted = await fetch(`${base}/docs/auth-refactor`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
    });
    expect(deleted.status).toBe(204);
    expect((await fetch(`${base}/docs/auth-refactor`)).status).toBe(404);
  });

  it('answers a real conflict with 409 and the DocConflict shape', async () => {
    const made = await json<{ rev: { id: string } }>(
      await post('/docs', { title: 'C', body: 'a\nb\nc\n' })
    );
    await post('/docs/c/seal', {});
    await post('/docs/c/edit', {
      ops: [{ op: 'replace', find: 'b\n', text: 'B1\n' }],
    });
    const res = await fetch(`${base}/docs/c/body`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await teammateToken()}`,
      },
      body: JSON.stringify({ baseRev: made.rev.id, body: 'a\nB2\nc\n' }),
    });
    expect(res.status).toBe(409);
    const body = await json<{
      code: string;
      reason: string;
      field: string;
      hunks: unknown[];
      marked: string;
      head: { n: number };
    }>(res);
    expect(body).toMatchObject({
      code: 'conflict',
      reason: 'merge-conflict',
      field: 'body',
      head: { n: 2 },
    });
    expect(body.hunks).toHaveLength(1);
    expect(body.marked).toContain('>>>>>>> yours');
  });

  it('replays an Idempotency-Key and stores the write once', async () => {
    const first = await post(
      '/docs',
      { title: 'Once', body: 'x\n' },
      { 'idempotency-key': 'k-1' }
    );
    const again = await post(
      '/docs',
      { title: 'Once', body: 'x\n' },
      { 'idempotency-key': 'k-1' }
    );
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(await json<unknown>(again)).toEqual(await json<unknown>(first));
    const listed = await json<{ total: number }>(await fetch(`${base}/docs`));
    expect(listed.total).toBe(1);
  });

  it('bounds request bodies at 2 MiB with 413', async () => {
    const res = await post('/docs', {
      title: 'Huge',
      body: 'x'.repeat(2 * 1024 * 1024 + 10),
    });
    expect(res.status).toBe(413);
  });

  it('lets a run create a doc linked to its own task, with its run token', async () => {
    const task = await json<{ meta: { id: string } }>(
      await post('/tasks', { title: 'Docs task' })
    );
    const run = await json<{ id: string }>(
      await post(`/tasks/${task.meta.id}/runs`, { executor: 'claude' })
    );
    await waitFor(
      async () =>
        (
          await json<{ meta: { state: string } }>(
            await fetch(`${base}/runs/${run.id}`)
          )
        ).meta.state === 'running'
    );
    const token = executor.lastRunToken ?? '';
    const res = await rawFetch(`${base}/docs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ title: 'Run notes', body: 'x\n' }),
    });
    expect(res.status).toBe(201);
    const linking = await json<{
      docs: { doc: { handle: string }; rel: string }[];
    }>(await fetch(`${base}/docs/links?target=task:${task.meta.id}`));
    expect(linking.docs.map((d) => [d.doc.handle, d.rel])).toEqual([
      ['run-notes', 'context'],
    ]);
  });

  it('broadcasts doc.changed with the id for team docs, and nothing else', async () => {
    const ws = new WebSocket(wsUrl(handle));
    const frames: { type: string; scope?: string; id?: string }[] = [];
    ws.onmessage = (e) =>
      frames.push(JSON.parse(String(e.data)) as { type: string });
    await waitFor(() => frames.some((f) => f.type === 'hello'));
    const made = await json<{ doc: { id: string }; rev: { id: string } }>(
      await post('/docs', { title: 'Evt', body: 'x\n' })
    );
    await waitFor(() => frames.some((f) => f.type === 'doc.changed'));
    const event = frames.find((f) => f.type === 'doc.changed');
    expect(event).toEqual({
      type: 'doc.changed',
      scope: 'team',
      id: made.doc.id,
    });
    ws.close();
  });

  it('keeps docs.db, -wal and -shm 0600, and re-applies the modes when a later boot opens them', async () => {
    await post('/docs', { title: 'Mode', body: 'x\n' });
    const path = join(runsDir(root), 'docs.db');
    const files = [path, `${path}-wal`, `${path}-shm`];
    expect(existsSync(`${path}-wal`)).toBe(true);
    for (const file of files) expect(statSync(file).mode & 0o777).toBe(0o600);
    await handle.stop();
    for (const file of files) if (existsSync(file)) chmodSync(file, 0o644);
    handle = await boot(root, executor);
    base = `http://127.0.0.1:${handle.port}/api`;
    await post('/docs', { title: 'Mode two', body: 'y\n' });
    for (const file of files) {
      if (existsSync(file)) expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('serves health to humans only', async () => {
    const health = await json<{ available: boolean; search: string }>(
      await fetch(`${base}/docs/health`)
    );
    expect(health.available).toBe(true);
    expect(['fts5', 'like']).toContain(health.search);
  });

  it("lists another checkout's orphaned docs.db to decide tier only", async () => {
    const orphanDir = join(fakeHome, '.dispatch', 'runs', '0123456789ab');
    mkdirSync(orphanDir, { recursive: true });
    const db = openSqliteDb(join(orphanDir, 'docs.db'));
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      'root',
      join(fakeHome, 'a-checkout-that-moved')
    );
    db.close();
    const decider = await json<{ orphans?: string[] }>(
      await fetch(`${base}/docs/health`)
    );
    expect(decider.orphans).toEqual([join(orphanDir, 'docs.db')]);
    const teammate = await json<{ orphans?: string[]; restore?: unknown }>(
      await fetch(`${base}/docs/health`, {
        headers: { authorization: `Bearer ${await teammateToken()}` },
      })
    );
    expect(teammate.orphans).toBeUndefined();
    expect(teammate.restore).toBeUndefined();
  });
});
