import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-impact-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  return dir;
}

let root: string;
let fakeHome: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  // startServer hydrates the merge queue, which writes run state under
  // DISPATCH_HOME — left unset it lands in the real home, one dir per test.
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
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

function authedGet(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

describe('GET /api/impact', () => {
  it('returns reach for a file subject', async () => {
    const res = await authedGet('/api/impact?subject=file&id=src/db/client.ts');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reach: { entries: unknown[]; sources: string[] };
    };
    expect(Array.isArray(body.reach.entries)).toBe(true);
    expect(body.reach.sources).toContain('scanner');
  });

  it('an unknown subject kind is a 400', async () => {
    const res = await authedGet('/api/impact?subject=banana&id=x');
    expect(res.status).toBe(400);
  });

  it('an unknown run is a 404, not a 500', async () => {
    const res = await authedGet('/api/impact?subject=run&id=r-nope');
    expect(res.status).toBe(404);
  });

  it('a path escaping the root is a 400', async () => {
    const res = await authedGet('/api/impact?subject=file&id=../../etc/passwd');
    expect(res.status).toBe(400);
  });

  it('a missing id is a 400', async () => {
    const res = await authedGet('/api/impact?subject=file');
    expect(res.status).toBe(400);
  });

  it('a task with declared writes resolves seeds against tracked files', async () => {
    const created = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'writes something', writes: ['*.ts'] }),
    });
    const { meta } = await json<{ meta: { id: string } }>(created);

    const res = await authedGet(`/api/impact?subject=task&id=${meta.id}`);
    expect(res.status).toBe(200);
    const body = await json<{ reach: { entries: unknown[] } }>(res);
    expect(Array.isArray(body.reach.entries)).toBe(true);
  });

  it(
    'a broken git checkout surfaces a controlled error, not a 500 and ' +
      'not a false-empty result',
    async () => {
      const created = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'writes something', writes: ['*.ts'] }),
      });
      const { meta } = await json<{ meta: { id: string } }>(created);

      // Simulates the class of failure `git ls-files` can hit in production
      // (a corrupt/missing index) — not reachable by mocking, since the
      // route spawns a real `git` process against `rootDir`.
      rmSync(join(root, '.git'), { recursive: true, force: true });

      const res = await authedGet(`/api/impact?subject=task&id=${meta.id}`);
      expect(res.status).toBe(502);
      expect(res.status).not.toBe(500);
      const body = await json<{ error: string; seeds?: unknown }>(res);
      expect(typeof body.error).toBe('string');
      // A stale/false "nothing is affected" would look like a seeds array.
      expect(body.seeds).toBeUndefined();
    }
  );
});
