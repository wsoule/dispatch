import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

function json(res: Response): Promise<any> {
  return res.json();
}

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-git-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
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

describe('POST /api/git/discard confirmation gate', () => {
  it('400s without confirm: true and leaves the file untouched', async () => {
    writeFileSync(join(root, 'scratch.txt'), 'temp\n');

    const res = await fetch(`${baseUrl}/api/git/discard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: ['scratch.txt'] }),
    });

    expect(res.status).toBe(400);
    const status = await json(await fetch(`${baseUrl}/api/git/status`));
    expect(status.untracked).toContain('scratch.txt');
  });

  it('succeeds once confirm: true is present', async () => {
    writeFileSync(join(root, 'scratch.txt'), 'temp\n');

    const res = await fetch(`${baseUrl}/api/git/discard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: ['scratch.txt'], confirm: true }),
    });

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
  });
});

describe('DELETE /api/git/branch/:name confirmation gate', () => {
  it('400s a force delete without confirm: true and leaves the branch in place', async () => {
    await fetch(`${baseUrl}/api/git/branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'feature/x' }),
    });

    const res = await fetch(`${baseUrl}/api/git/branch/feature%2Fx`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });

    expect(res.status).toBe(400);
    const branches = await json(await fetch(`${baseUrl}/api/git/branches`));
    expect(branches.branches.map((b: { name: string }) => b.name)).toContain(
      'feature/x'
    );
  });

  it('succeeds once confirm: true is present', async () => {
    await fetch(`${baseUrl}/api/git/branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'feature/y' }),
    });

    const res = await fetch(`${baseUrl}/api/git/branch/feature%2Fy`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true, confirm: true }),
    });

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
  });
});

describe('POST /api/git/stash/drop confirmation gate', () => {
  async function pushOneStash(): Promise<void> {
    writeFileSync(join(root, 'README.md'), 'edited\n');
    await fetch(`${baseUrl}/api/git/stash`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  }

  it('400s without confirm: true and leaves the stash in place', async () => {
    await pushOneStash();

    const res = await fetch(`${baseUrl}/api/git/stash/drop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ index: 0 }),
    });

    expect(res.status).toBe(400);
    const list = await json(await fetch(`${baseUrl}/api/git/stash`));
    expect(list.stashes).toHaveLength(1);
  });

  it('succeeds once confirm: true is present', async () => {
    await pushOneStash();

    const res = await fetch(`${baseUrl}/api/git/stash/drop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ index: 0, confirm: true }),
    });

    expect(res.status).toBe(200);
    const list = await json(await fetch(`${baseUrl}/api/git/stash`));
    expect(list.stashes).toEqual([]);
  });
});

// A hostile cross-origin "simple" request can never set application/json —
// this is what actually stops it, not just the CORS allowlist.
describe('git mutation routes require content-type: application/json', () => {
  it('415s a POST with no content-type header at all', async () => {
    const res = await fetch(`${baseUrl}/api/git/stage`, {
      method: 'POST',
      body: JSON.stringify({ paths: ['README.md'] }),
    });

    expect(res.status).toBe(415);
  });

  it('415s a POST sent as a CORS-simple content-type', async () => {
    const res = await fetch(`${baseUrl}/api/git/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ remote: 'https://attacker.example/x.git' }),
    });

    expect(res.status).toBe(415);
  });
});

describe('POST /api/git/checkout refuses a name that collides with a directory', () => {
  it('does not silently discard uncommitted work under a same-named directory', async () => {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'app.ts'), 'export const x = 1;\n');
    await fetch(`${baseUrl}/api/git/stage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: ['src/app.ts'] }),
    });
    await fetch(`${baseUrl}/api/git/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'chore: seed src/app.ts' }),
    });
    writeFileSync(
      join(root, 'src', 'app.ts'),
      'export const x = 2; // uncommitted\n'
    );

    const res = await fetch(`${baseUrl}/api/git/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: 'src' }),
    });

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(false);
    const status = await json(await fetch(`${baseUrl}/api/git/status`));
    expect(status.unstaged).toEqual([{ path: 'src/app.ts', status: 'M' }]);
  });
});
