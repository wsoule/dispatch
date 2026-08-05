import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256Hex } from '../src/api.js';
import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import type { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { RunRegistry } from '../src/orchestrator/registry.js';
import type { RunState } from '../src/orchestrator/types.js';
import type { ReviewComment } from '../src/reviewComments.js';
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

// Merges via `Headers` rather than an object spread: `init.headers` is a
// `HeadersInit`, which can be an array or a `Headers` instance — spreading
// either into a plain object silently drops the entries instead of merging.
function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return fetch(`${baseUrl}${path}`, { ...init, headers });
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

// Leaves a review comment via the real HTTP route and hands back the parsed
// comment — every apply test needs a real commentId to act on, and `pending:
// false` keeps the comment out of the way of anything that filters on it.
async function addComment(input: {
  file: string;
  line: number;
  anchorText: string;
  suggestion?: string;
}): Promise<ReviewComment> {
  const res = await apiFetch(`/api/runs/${runId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ ...input, body: 'note', pending: false }),
  });
  return json<ReviewComment>(res);
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

  it('does not disclose a file reached through a leaf symlink', async () => {
    // A worktree file committed as a symlink — `evil.txt -> /outside/secret.txt`
    // — reads as an ordinary relative path but fs.readFileSync (used for
    // side=new) follows it straight to the external target.
    const outside = mkdtempSync(
      join(tmpdir(), 'dispatch-run-file-edits-read-leaf-outside-')
    );
    const externalTarget = join(outside, 'secret.txt');
    writeFileSync(externalTarget, 'original-secret\n');
    symlinkSync(externalTarget, join(worktree, 'evil.txt'));

    try {
      const res = await apiFetch(
        `/api/runs/${runId}/file?path=evil.txt&side=new`
      );
      // The status check alone is the point (reject outright, see
      // resolveWorktreeFilePath) but the disclosure check is what actually
      // matters: whatever the status, the external file's contents must
      // never appear in the response.
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).not.toContain('original-secret');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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

  it('404s for a run that does not exist', async () => {
    const res = await apiFetch(`/api/runs/does-not-exist/edits`, {
      method: 'POST',
      body: JSON.stringify({ file: 'a.txt', contents: 'x\n', baseSha: 'x' }),
    });

    expect(res.status).toBe(404);
  });

  it('409s when the worktree directory is gone', async () => {
    rmSync(worktree, { recursive: true, force: true });

    const res = await apiFetch(`/api/runs/${runId}/edits`, {
      method: 'POST',
      body: JSON.stringify({ file: 'a.txt', contents: 'x\n', baseSha: 'x' }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'worktree-missing',
    });
  });

  it('refuses a write through a symlinked directory that escapes the worktree', async () => {
    // A worktree can contain a committed symlinked directory pointing
    // anywhere on disk; `linkdir/target.txt` reads as an ordinary relative
    // path but the real destination is outside the worktree entirely.
    const outside = mkdtempSync(
      join(tmpdir(), 'dispatch-run-file-edits-outside-')
    );
    const externalTarget = join(outside, 'target.txt');
    const externalContents = 'do-not-touch\n';
    writeFileSync(externalTarget, externalContents);
    symlinkSync(outside, join(worktree, 'linkdir'));

    // A failed `stage()` reverts the file to its previous contents, so
    // content alone can look identical whether or not a write ever
    // physically reached this path — the on-disk mtime is what actually
    // shows whether anything touched it, since a write-then-revert still
    // performs two real writes.
    const mtimeBefore = statSync(externalTarget).mtimeMs;

    try {
      // baseSha matches the real (external) file's contents so the
      // stale-base precondition can't be what stops this write — only the
      // symlink-aware path check standing between the request and
      // writeFileSync can.
      const res = await apiFetch(`/api/runs/${runId}/edits`, {
        method: 'POST',
        body: JSON.stringify({
          file: 'linkdir/target.txt',
          contents: 'evil\n',
          baseSha: sha256Hex(externalContents),
        }),
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(readFileSync(externalTarget, 'utf8')).toBe(externalContents);
      // The assertion that actually matters: writeFileSync must never have
      // been called on the external target at all, not merely reverted back
      // to matching content after the fact.
      expect(statSync(externalTarget).mtimeMs).toBe(mtimeBefore);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a write through a leaf symlink that escapes the worktree', async () => {
    // Unlike a symlinked directory, this is a worktree file that is itself a
    // symlink — `evil.txt -> /outside/secret.txt`. git treats a symlink as
    // an ordinary blob and never follows it, but fs.writeFileSync does, so
    // this is a distinct escape from the directory case above.
    const outside = mkdtempSync(
      join(tmpdir(), 'dispatch-run-file-edits-leaf-outside-')
    );
    const externalTarget = join(outside, 'secret.txt');
    const externalContents = 'original-secret\n';
    writeFileSync(externalTarget, externalContents);
    symlinkSync(externalTarget, join(worktree, 'evil.txt'));

    const mtimeBefore = statSync(externalTarget).mtimeMs;

    try {
      const res = await apiFetch(`/api/runs/${runId}/edits`, {
        method: 'POST',
        body: JSON.stringify({
          file: 'evil.txt',
          contents: 'PWNED\n',
          baseSha: sha256Hex(externalContents),
        }),
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(readFileSync(externalTarget, 'utf8')).toBe(externalContents);
      expect(statSync(externalTarget).mtimeMs).toBe(mtimeBefore);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('POST /api/runs/:id/comments/:id/apply', () => {
  it('commits the suggestion when the anchor is exact', async () => {
    const comment = await addComment({
      file: 'a.txt',
      line: 1,
      anchorText: 'changed',
      suggestion: 'fixed',
    });

    const res = await apiFetch(
      `/api/runs/${runId}/comments/${comment.id}/apply`,
      { method: 'POST' }
    );

    expect(res.status).toBe(200);
    expect(readFileSync(join(worktree, 'a.txt'), 'utf8')).toBe('fixed\n');
  });

  it('marks the commit with the reviewer trailer and a suggestion-specific subject', async () => {
    const comment = await addComment({
      file: 'a.txt',
      line: 1,
      anchorText: 'changed',
      suggestion: 'fixed',
    });

    await apiFetch(`/api/runs/${runId}/comments/${comment.id}/apply`, {
      method: 'POST',
    });

    const log = Bun.spawnSync(['git', 'log', '-1', '--format=%B'], {
      cwd: worktree,
    });
    const message = log.stdout.toString();
    expect(message).toContain('review: apply suggestion on a.txt');
    expect(message).toContain(`Dispatch-Reviewer-Edit: ${runId}`);
  });

  it('does not resolve the comment thread', async () => {
    const comment = await addComment({
      file: 'a.txt',
      line: 1,
      anchorText: 'changed',
      suggestion: 'fixed',
    });

    await apiFetch(`/api/runs/${runId}/comments/${comment.id}/apply`, {
      method: 'POST',
    });

    const comments = await json<ReviewComment[]>(
      await apiFetch(`/api/runs/${runId}/comments`)
    );
    expect(comments.find((c) => c.id === comment.id)?.resolved).toBe(false);
  });

  it('409s when the anchor has drifted', async () => {
    const comment = await addComment({
      file: 'a.txt',
      line: 1,
      anchorText: 'something else',
      suggestion: 'fixed',
    });

    const res = await apiFetch(
      `/api/runs/${runId}/comments/${comment.id}/apply`,
      { method: 'POST' }
    );

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'anchor-drifted',
    });
  });

  it('400s for a comment with no suggestion', async () => {
    const comment = await addComment({
      file: 'a.txt',
      line: 1,
      anchorText: 'changed',
    });

    const res = await apiFetch(
      `/api/runs/${runId}/comments/${comment.id}/apply`,
      { method: 'POST' }
    );

    expect(res.status).toBe(400);
  });

  it('404s for a comment that does not exist', async () => {
    const res = await apiFetch(
      `/api/runs/${runId}/comments/does-not-exist/apply`,
      { method: 'POST' }
    );

    expect(res.status).toBe(404);
  });

  it('409s while a non-terminal run occupies the worktree', async () => {
    registerRunInWorktree({ state: 'running', worktreePath: worktree });
    const comment = await addComment({
      file: 'a.txt',
      line: 1,
      anchorText: 'changed',
      suggestion: 'fixed',
    });

    const res = await apiFetch(
      `/api/runs/${runId}/comments/${comment.id}/apply`,
      { method: 'POST' }
    );

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'worktree-busy',
    });
  });

  it('409s when the worktree directory is gone', async () => {
    const comment = await addComment({
      file: 'a.txt',
      line: 1,
      anchorText: 'changed',
      suggestion: 'fixed',
    });
    rmSync(worktree, { recursive: true, force: true });

    const res = await apiFetch(
      `/api/runs/${runId}/comments/${comment.id}/apply`,
      { method: 'POST' }
    );

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'worktree-missing',
    });
  });
});
