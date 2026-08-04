import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256Hex } from '../src/api.js';
import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import type { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { RunRegistry } from '../src/orchestrator/registry.js';
import type { RunState } from '../src/orchestrator/types.js';
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
let worktree: string;
let orchestrator: Orchestrator;
const originalDispatchHome = process.env.DISPATCH_HOME;

function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
}

// Registers a second run directly in the orchestrator's registry, sharing
// `worktreePath` with the primary run. This is exactly what requestChanges()
// does when a human asks for follow-up changes on a finished run, so it's
// the real shape the worktree-busy check has to defend against.
function registerRunInWorktree(opts: {
  state: RunState;
  worktreePath: string;
}): void {
  const registry = (orchestrator as unknown as { registry: RunRegistry })
    .registry;
  const now = new Date().toISOString();
  registry.create({
    id: `busy-${now}`,
    taskId: 'busy-task',
    taskTitle: 'busy',
    executor: 'fake',
    state: opts.state,
    branch: 'busy-branch',
    baseBranch: 'main',
    worktreePath: opts.worktreePath,
    createdAt: now,
    updatedAt: now,
  });
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
    registerExecutors: (o) => {
      orchestrator = o;
      o.registerExecutor(
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
  await waitFor(async () => {
    const detail = await json<{
      meta: { state: string; worktreePath: string };
    }>(await apiFetch(`/api/runs/${runId}`));
    worktree = detail.meta.worktreePath;
    return detail.meta.state === 'finished';
  });
  writeFileSync(join(worktree, 'a.txt'), 'changed\n');
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

describe('POST /api/runs/:id/edits', () => {
  it('writes the file and commits it on the run branch', async () => {
    const before = await apiFetch(
      `/api/runs/${runId}/file?path=a.txt&side=new`
    );
    const { sha } = (await before.json()) as { sha: string };

    const res = await apiFetch(`/api/runs/${runId}/edits`, {
      method: 'POST',
      body: JSON.stringify({
        file: 'a.txt',
        contents: 'fixed\n',
        baseSha: sha,
      }),
    });

    expect(res.status).toBe(200);
    const { commit } = (await res.json()) as { commit: string };
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(worktree, 'a.txt'), 'utf8')).toBe('fixed\n');
  });

  it('marks the commit with the reviewer trailer', async () => {
    const before = await apiFetch(
      `/api/runs/${runId}/file?path=a.txt&side=new`
    );
    const { sha } = (await before.json()) as { sha: string };
    await apiFetch(`/api/runs/${runId}/edits`, {
      method: 'POST',
      body: JSON.stringify({
        file: 'a.txt',
        contents: 'fixed\n',
        baseSha: sha,
      }),
    });

    const log = Bun.spawnSync(['git', 'log', '-1', '--format=%B'], {
      cwd: worktree,
    });
    const message = log.stdout.toString();
    expect(message).toContain('review: edit a.txt');
    expect(message).toContain(`Dispatch-Reviewer-Edit: ${runId}`);
  });

  it('409s when the file changed under the editor', async () => {
    const res = await apiFetch(`/api/runs/${runId}/edits`, {
      method: 'POST',
      body: JSON.stringify({
        file: 'a.txt',
        contents: 'x\n',
        baseSha: 'deadbeef',
      }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'stale-base',
    });
  });

  it('409s on empty contents for a non-empty file', async () => {
    const before = await apiFetch(
      `/api/runs/${runId}/file?path=a.txt&side=new`
    );
    const { sha } = (await before.json()) as { sha: string };

    const res = await apiFetch(`/api/runs/${runId}/edits`, {
      method: 'POST',
      body: JSON.stringify({ file: 'a.txt', contents: '', baseSha: sha }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'empty-contents',
    });
  });

  it('409s while a non-terminal run occupies the worktree', async () => {
    // Put a second, still-running run in the same worktree — exactly what
    // requestChanges() does — and the edit must refuse.
    registerRunInWorktree({ state: 'running', worktreePath: worktree });

    const before = await apiFetch(
      `/api/runs/${runId}/file?path=a.txt&side=new`
    );
    const { sha } = (await before.json()) as { sha: string };
    const res = await apiFetch(`/api/runs/${runId}/edits`, {
      method: 'POST',
      body: JSON.stringify({
        file: 'a.txt',
        contents: 'fixed\n',
        baseSha: sha,
      }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'worktree-busy',
    });
  });

  it('refuses a path that escapes the worktree', async () => {
    const res = await apiFetch(`/api/runs/${runId}/edits`, {
      method: 'POST',
      body: JSON.stringify({
        file: '../escape.txt',
        contents: 'x\n',
        baseSha: 'x',
      }),
    });

    expect(res.status).toBe(400);
  });
});
