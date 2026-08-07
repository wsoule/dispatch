import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-conversations-api-'));
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

describe('conversation routes', () => {
  it('round-trips a message for a run subject', async () => {
    const post = await apiFetch('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({
        subject: 'run:r-1',
        role: 'human',
        body: 'why this?',
        snippets: [
          { file: 'a.ts', startLine: 1, endLine: 2, text: 'const a = 1;' },
        ],
        target: 'run-agent',
      }),
    });
    expect(post.status).toBe(201);

    const res = await apiFetch('/api/conversations?subject=run%3Ar-1');
    const all = (await res.json()) as { body: string }[];
    expect(all).toHaveLength(1);
    expect(all[0]?.body).toBe('why this?');
  });

  it('keeps a worktree subject separate from a run subject', async () => {
    await apiFetch('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({
        subject: 'run:r-1',
        role: 'human',
        body: 'run',
        snippets: [],
      }),
    });
    const res = await apiFetch(
      `/api/conversations?subject=${encodeURIComponent('worktree:/tmp/p')}`
    );
    expect((await res.json()) as unknown[]).toEqual([]);
  });

  it('400s an unrecognised subject rather than inventing a namespace', async () => {
    const res = await apiFetch('/api/conversations?subject=session%3A1');
    expect(res.status).toBe(400);
  });

  it('400s a POST with no subject', async () => {
    const res = await apiFetch('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ role: 'human', body: 'x', snippets: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('400s a DELETE with an unrecognised subject', async () => {
    const res = await apiFetch(
      '/api/conversations/cm-abc?subject=session%3A1',
      {
        method: 'DELETE',
      }
    );
    expect(res.status).toBe(400);
  });

  it('deletes one message and leaves the rest', async () => {
    const a = await (
      await apiFetch('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({
          subject: 'run:r-1',
          role: 'human',
          body: 'a',
          snippets: [],
        }),
      })
    ).json();
    await apiFetch('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({
        subject: 'run:r-1',
        role: 'human',
        body: 'b',
        snippets: [],
      }),
    });

    const del = await apiFetch(
      `/api/conversations/${(a as { id: string }).id}?subject=run%3Ar-1`,
      { method: 'DELETE' }
    );
    expect(del.status).toBe(204);

    const rest = (await (
      await apiFetch('/api/conversations?subject=run%3Ar-1')
    ).json()) as {
      body: string;
    }[];
    expect(rest.map((m) => m.body)).toEqual(['b']);
  });
});
