import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256Hex } from '../src/api.js';
import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

// a.txt is committed at the base commit so `side=old` has something to show;
// the run's worktree gets an uncommitted edit on top in beforeEach so
// `side=new` has a real working-tree difference to serve.
function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-run-file-edits-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
let runId: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

function apiFetch(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor timed out');
}

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor(
        'fake',
        new FakeExecutor({ finish: { state: 'finished' } })
      );
    },
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;

  const taskRes = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'edit a.txt' }),
  });
  const taskId = (await json<{ meta: { id: string } }>(taskRes)).meta.id;
  const runRes = await fetch(`${baseUrl}/api/tasks/${taskId}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ executor: 'fake' }),
  });
  runId = (await json<{ id: string }>(runRes)).id;

  // Poll until the fake run reaches its terminal state, capturing the real
  // worktree path it was assigned, then dirty that worktree so `side=new`
  // has an uncommitted edit to read back.
  let worktreePath = '';
  await waitFor(async () => {
    const detail = await json<{
      meta: { state: string; worktreePath: string };
    }>(await apiFetch(`/api/runs/${runId}`));
    worktreePath = detail.meta.worktreePath;
    return detail.meta.state === 'finished';
  });
  writeFileSync(join(worktreePath, 'a.txt'), 'changed\n');
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('GET /api/runs/:id/file', () => {
  it('returns the working-tree side with its sha', async () => {
    const res = await apiFetch(`/api/runs/${runId}/file?path=a.txt&side=new`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contents: string; sha: string };
    expect(body.contents).toBe('changed\n');
    expect(body.sha).toBe(sha256Hex('changed\n'));
  });

  it('returns the committed side', async () => {
    const res = await apiFetch(`/api/runs/${runId}/file?path=a.txt&side=old`);
    const body = (await res.json()) as { contents: string };
    expect(body.contents).toBe('hello\n');
  });

  it('404s for a file missing on that side', async () => {
    const res = await apiFetch(
      `/api/runs/${runId}/file?path=nope.txt&side=old`
    );
    expect(res.status).toBe(404);
  });

  it('400s for a missing path', async () => {
    const res = await apiFetch(`/api/runs/${runId}/file?side=new`);
    expect(res.status).toBe(400);
  });

  it('refuses a path that escapes the worktree', async () => {
    const res = await apiFetch(
      `/api/runs/${runId}/file?path=../../etc/passwd&side=new`
    );
    expect(res.status).toBe(400);
  });
});
