import { openSqliteDb } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

  it('takes import contents only as application/octet-stream', async () => {
    const bytes = new TextEncoder().encode('# A\n');
    const hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    const opened = await json<{ id: string; need: string[] }>(
      await post('/docs/imports', {
        files: [
          {
            path: '/x/a.md',
            name: 'a.md',
            mtime: '2026-09-26T10:00:00.000Z',
            bytes: bytes.byteLength,
            hash,
          },
        ],
      })
    );
    expect(opened.need).toEqual([hash]);
    const put = (headers: Record<string, string>) =>
      fetch(`${base}/docs/imports/${opened.id}/contents/${hash}`, {
        method: 'PUT',
        headers,
        body: bytes,
      });
    expect((await put({ 'content-type': 'text/plain' })).status).toBe(415);
    expect((await put({})).status).toBe(415);
    expect(
      (await put({ 'content-type': 'application/x-www-form-urlencoded' }))
        .status
    ).toBe(415);
    expect(
      (await put({ 'content-type': 'application/octet-stream' })).status
    ).toBe(204);
    const commit = await post(`/docs/imports/${opened.id}/commit`, {});
    expect(await json<unknown>(commit)).toMatchObject({
      dryRun: false,
      docsCreated: 1,
      parity: { files: true, names: true },
    });
    const read = await json<{ text: string }>(await fetch(`${base}/docs/a`));
    expect(read.text).toBe('# A\n');
    const gone = await fetch(`${base}/docs/imports/${opened.id}`, {
      method: 'DELETE',
    });
    expect(gone.status).toBe(404);
  });

  it('refuses an import manifest entry without an ISO mtime', async () => {
    const res = await post('/docs/imports', {
      files: [
        { path: 'a.md', name: 'a.md', mtime: 'yesterday', bytes: 1, hash: 'h' },
      ],
    });
    expect(res.status).toBe(400);
    expect((await json<{ field: string }>(res)).field).toBe('files[0].mtime');
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

  it("answers 404 to a teammate asking for a run's proposal, its diff or its text", async () => {
    await post('/docs', { title: 'Spec', body: 'v1\n' });
    expect(
      (await post('/docs/spec/status', { status: 'accepted' })).status
    ).toBe(200);
    const task = await json<{ meta: { id: string } }>(
      await post('/tasks', { title: 'Proposing task' })
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
    const edited = await rawFetch(`${base}/docs/spec/edit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${executor.lastRunToken ?? ''}`,
      },
      body: JSON.stringify({ ops: [{ op: 'append', text: 'secret' }] }),
    });
    const { proposal } = await json<{ proposal: string }>(edited);
    expect((await fetch(`${base}/docs/proposals/${proposal}`)).status).toBe(
      200
    );
    const teammate = { authorization: `Bearer ${await teammateToken()}` };
    for (const path of [
      `/docs/proposals/${proposal}`,
      `/docs/spec/diff?from=1&to=${proposal}`,
      `/docs/spec?rev=${proposal}`,
    ]) {
      const res = await rawFetch(`${base}${path}`, { headers: teammate });
      expect([path, res.status]).toEqual([path, 404]);
    }
  });

  it("serves a conflicting proposal's marked merge for the merge view", async () => {
    await post('/docs', { title: 'Spec', body: '# Spec\n## A\nv1\n' });
    await post('/docs/spec/status', { status: 'accepted' });
    const task = await json<{ meta: { id: string } }>(
      await post('/tasks', { title: 'Proposing task' })
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
    const edited = await rawFetch(`${base}/docs/spec/edit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${executor.lastRunToken ?? ''}`,
      },
      body: JSON.stringify({
        ops: [{ op: 'replace_section', section: 'A', text: 'run' }],
      }),
    });
    const { proposal } = await json<{ proposal: string }>(edited);
    await post('/docs/spec/edit', {
      ops: [{ op: 'replace_section', section: 'A', text: 'human' }],
    });
    const view = await json<{
      mergeable: { clean: boolean };
      marked: string | null;
    }>(await fetch(`${base}/docs/proposals/${proposal}`));
    expect(view.mergeable.clean).toBe(false);
    expect(view.marked).toContain('<<<<<<< ');
    expect(view.marked).toContain('run\n');
  });

  it("answers a task's index lines, and a dispatched run's prompt carries them", async () => {
    const task = await json<{ meta: { id: string } }>(
      await post('/tasks', { title: 'Indexed task' })
    );
    const created = await post('/docs', {
      title: 'Auth spec',
      body: '# Auth\nSigned tokens.\n',
      links: [{ target: `task:${task.meta.id}`, rel: 'spec' }],
    });
    expect(created.status).toBe(201);
    const index = await fetch(`${base}/docs/index?taskId=${task.meta.id}`);
    expect(index.status).toBe(200);
    const specLine =
      '- spec · auth-spec · draft · rev 1 · 1 KB: Auth spec: Signed tokens.';
    expect((await json<{ lines: string[] }>(index)).lines).toEqual([specLine]);
    expect((await fetch(`${base}/docs/index`)).status).toBe(400);
    await post(`/tasks/${task.meta.id}/runs`, { executor: 'claude' });
    await waitFor(() => executor.started.length === 1);
    expect(executor.started[0].prompt).toContain(`## Docs\n`);
    expect(executor.started[0].prompt).toContain(specLine);
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
    const assets = join(runsDir(root), 'docs-assets');
    expect(statSync(assets).mode & 0o777).toBe(0o700);
    chmodSync(assets, 0o755);
    handle = await boot(root, executor);
    base = `http://127.0.0.1:${handle.port}/api`;
    await post('/docs', { title: 'Mode two', body: 'y\n' });
    for (const file of files) {
      if (existsSync(file)) expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(statSync(assets).mode & 0o777).toBe(0o700);
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

describe('publish route', () => {
  type Published = {
    task: string;
    run: string | null;
    dispatchError: string | null;
    doc: { published: unknown; lastPublishPath: string | null };
  };

  it('creates the elevated task, dispatches it with the doc seeded, and refuses a run or a bad path', async () => {
    await post('/docs', { title: 'Spec', body: '# Spec v1\n' });
    expect(
      (await post('/docs/spec/publish', { path: '../escape.md' })).status
    ).toBe(400);
    expect(
      (await post('/docs/spec/publish', { path: '.github/ci.md' })).status
    ).toBe(400);
    const res = await post('/docs/spec/publish', { path: 'docs/spec.md' });
    expect(res.status).toBe(201);
    const out = await json<Published>(res);
    expect(out.dispatchError).toBeNull();
    expect(out.doc.lastPublishPath).toBe('docs/spec.md');
    const task = await json<{ meta: { risk: string; writes: string[] } }>(
      await fetch(`${base}/tasks/${out.task}`)
    );
    expect(task.meta.risk).toBe('elevated');
    expect(task.meta.writes).toEqual(['docs/spec.md']);
    const cwd = executor.started.at(-1)?.cwd ?? '';
    expect(readFileSync(join(cwd, 'docs/spec.md'), 'utf8')).toBe('# Spec v1\n');

    await waitFor(async () => {
      const run = await json<{ meta: { state: string } }>(
        await fetch(`${base}/runs/${out.run}`)
      );
      return run.meta.state === 'running';
    });
    const refused = await rawFetch(`${base}/docs/spec/publish`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${executor.lastRunToken ?? ''}`,
      },
      body: JSON.stringify({ path: 'docs/other.md' }),
    });
    expect(refused.status).toBe(403);
  });

  it("runs a publish for the human who asked: a teammate's for them, the owner's app token for the owner", async () => {
    await post('/docs', { title: 'Spec', body: '# Spec\n' });
    await post('/docs', { title: 'Plan', body: '# Plan\n' });
    const operatorOf = (runId: string | null) =>
      handle.orchestrator.list().find((r) => r.id === runId)?.operator;
    const mine = await json<Published>(
      await post('/docs/spec/publish', { path: 'docs/spec.md' })
    );
    const ownerRun = handle.orchestrator.list().find((r) => r.id === mine.run);
    expect(ownerRun?.operator).toBe(ownerRun?.dispatchedBy);
    expect(ownerRun?.operator).toMatch(/^human:/);
    const teammate = await teammateToken();
    const theirs = await json<Published>(
      await rawFetch(`${base}/docs/plan/publish`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${teammate}`,
        },
        body: JSON.stringify({ path: 'docs/plan.md' }),
      })
    );
    expect(theirs.dispatchError).toBeNull();
    expect(operatorOf(theirs.run)).toBe('human:alice');
    // The shared agent token never reaches the docs routes, so it starts no publish run.
    const viaAgent = await rawFetch(`${base}/docs/plan/publish`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${handle.tokens.agentToken}`,
      },
      body: JSON.stringify({ path: 'docs/plan2.md' }),
    });
    expect(viaAgent.status).toBe(403);
  });

  it("keeps a publish task's risk at decide tier: a teammate and the agent token are refused", async () => {
    await post('/docs', { title: 'Spec', body: '# Spec\n' });
    const out = await json<Published>(
      await post('/docs/spec/publish', {
        path: 'docs/spec.md',
        dispatch: false,
      })
    );
    const patchRisk = (headers: Record<string, string>) =>
      rawFetch(`${base}/tasks/${out.task}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ risk: 'routine' }),
      });
    const teammate = await teammateToken();
    for (const token of [teammate, handle.tokens.agentToken]) {
      const res = await patchRisk({ authorization: `Bearer ${token}` });
      expect(res.status).toBe(403);
    }
    const task = await json<{ meta: { risk: string } }>(
      await fetch(`${base}/tasks/${out.task}`)
    );
    expect(task.meta.risk).toBe('elevated');
    // Other fields stay open to a teammate.
    const titled = await rawFetch(`${base}/tasks/${out.task}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${teammate}`,
      },
      body: JSON.stringify({ title: 'Publish the spec' }),
    });
    expect(titled.status).toBe(200);
    const owner = await fetch(`${base}/tasks/${out.task}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ risk: 'critical' }),
    });
    expect(owner.status).toBe(200);
  });

  it('records no landing from a status alone: the task needs a merged run', async () => {
    await post('/docs', { title: 'Spec', body: '# Spec\n' });
    const out = await json<Published>(
      await post('/docs/spec/publish', {
        path: 'docs/spec.md',
        dispatch: false,
      })
    );
    expect(out.run).toBeNull();
    const patched = await fetch(`${base}/tasks/${out.task}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'landed' }),
    });
    expect(patched.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const read = await json<{ doc: { published: unknown } }>(
      await fetch(`${base}/docs/spec`)
    );
    expect(read.doc.published).toBeNull();
    expect(
      (await post('/docs/spec/publish', { path: 'docs/again.md' })).status
    ).toBe(409);
  });
});

describe('image routes', () => {
  const octet = { 'content-type': 'application/octet-stream' };
  const png = (tail: number) =>
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tail]);
  const upload = (
    doc: string,
    body: Uint8Array | string,
    headers: Record<string, string> = octet
  ) => fetch(`${base}/docs/${doc}/assets`, { method: 'POST', headers, body });

  it('stores an image by its sniffed type, serves it sandboxed, and refuses SVG and oversize bodies', async () => {
    await post('/docs', { title: 'Img', body: 'x\n' });
    const up = await upload('img', png(1));
    expect(up.status).toBe(201);
    const { name, markdown } = await json<{ name: string; markdown: string }>(
      up
    );
    expect(name).toMatch(/^[0-9a-f]{64}\.png$/);
    expect(markdown).toBe(`![](asset:${name})`);
    const got = await fetch(`${base}/docs/img/assets/${name}`);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(got.headers.get('content-security-policy')).toBe(
      "default-src 'none'; sandbox"
    );
    expect(got.headers.get('content-disposition')).toBe(
      `inline; filename="${name}"`
    );
    expect(got.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(png(1));
    expect((await upload('img', '<svg/>')).status).toBe(400);
    expect((await upload('img', new Uint8Array(0))).status).toBe(400);
    const huge = new Uint8Array(25 * 1024 * 1024 + 1);
    huge.set(png(2));
    expect((await upload('img', huge)).status).toBe(413);
  });

  it("answers a caller who may not write before reading the upload's body", async () => {
    await post('/docs', { title: 'Img', body: 'x\n' });
    await post('/docs/img/status', { status: 'archived' });
    const huge = new Uint8Array(25 * 1024 * 1024 + 1);
    huge.set(png(4));
    expect((await upload('img', huge)).status).toBe(409);
  });

  it('refuses an image upload that is not application/octet-stream', async () => {
    await post('/docs', { title: 'Img', body: 'x\n' });
    for (const headers of [
      { 'content-type': 'text/plain' },
      { 'content-type': 'image/png' },
      { 'content-type': 'image/svg+xml' },
    ]) {
      expect((await upload('img', png(3), headers)).status).toBe(415);
    }
  });

  it('reads an asset only by a well-formed name with a row for that doc, never a path', async () => {
    await post('/docs', { title: 'Img', body: 'x\n' });
    await post('/docs', { title: 'Other', body: 'y\n' });
    const { name } = await json<{ name: string }>(await upload('img', png(7)));
    for (const bad of [
      encodeURIComponent('../../docs.db'),
      encodeURIComponent('../docs.db'),
      `${name.slice(0, 60)}.svg`,
      `${name}%00.png`,
      'docs.db',
    ]) {
      expect([
        bad,
        (await fetch(`${base}/docs/img/assets/${bad}`)).status,
      ]).toEqual([bad, 400]);
    }
    expect(
      (await fetch(`${base}/docs/img/assets/${'b'.repeat(64)}.png`)).status
    ).toBe(404);
    expect((await fetch(`${base}/docs/other/assets/${name}`)).status).toBe(404);
  });
});
