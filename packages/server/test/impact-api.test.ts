import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

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
});
