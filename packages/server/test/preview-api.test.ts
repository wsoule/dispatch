import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';
import { rawFetch } from './testAuth.js';

// The routes and the proxy, wired end to end through a real daemon. Nothing
// here starts a dev server: the supervisor's own lifecycle is covered by
// preview.test.ts against its injected seams, and spawning one from an
// integration test would make the suite depend on a package manager.

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-preview-api-'));
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
  // The suite's setup.ts fails any test whose daemon state escapes to the
  // real ~/.dispatch, so every server test points DISPATCH_HOME at a temp dir.
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  TaskStore.init(root);
  handle = await startServer({ rootDir: root, port: 0, webDistDir: null });
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function auth(token: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };
}

it('reports no preview for a run that has none, without starting one', async () => {
  const res = await rawFetch(`${baseUrl}/api/runs/r-nothing/preview`, {
    headers: auth(handle.tokens.agentToken),
  });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ preview: null });
});

it('refuses to start a preview for a run that does not exist', async () => {
  const res = await rawFetch(`${baseUrl}/api/runs/r-nothing/preview`, {
    method: 'POST',
    headers: auth(handle.tokens.appToken),
  });

  expect(res.status).toBe(404);
});

it('starting a preview needs the decide tier, not the agent token', async () => {
  // Starting one runs a command out of the run's own worktree — code the
  // agent may have written. The agent token must not reach it.
  const res = await rawFetch(`${baseUrl}/api/runs/r-1/preview`, {
    method: 'POST',
    headers: auth(handle.tokens.agentToken),
  });

  expect(res.status).toBe(403);
});

it('stopping a preview needs the decide tier too', async () => {
  // Paired with start so the control surface is not half-privileged.
  const res = await rawFetch(`${baseUrl}/api/runs/r-1/preview`, {
    method: 'DELETE',
    headers: auth(handle.tokens.agentToken),
  });

  expect(res.status).toBe(403);
});

it('stopping a preview that does not exist is a no-op, not an error', async () => {
  const res = await rawFetch(`${baseUrl}/api/runs/r-nothing/preview`, {
    method: 'DELETE',
    headers: auth(handle.tokens.appToken),
  });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

it('the proxy 404s a run with no preview rather than hanging', async () => {
  const res = await rawFetch(`${baseUrl}/preview/r-nothing/index.html`);

  expect(res.status).toBe(404);
});

it('the proxy path does not fall through to the API router', async () => {
  // /preview/ is checked before /api/ and the static fallback; a regression
  // that reordered them would surface here as an auth error instead of a 404.
  const res = await rawFetch(`${baseUrl}/preview/r-nothing/`);

  expect(res.status).toBe(404);
  expect(await res.text()).toBe('no preview for this run');
});
