import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// @dispatch/client declares `content-type: application/json` on every write,
// including the ones that send no body at all. These routes therefore have to
// keep accepting a declared content-type over an empty body — a reader that
// insisted on parseable JSON would break the desktop's cancel, pull and
// enqueue buttons rather than any attacker.

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-bodyless-'));
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
  root = initRepo();
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

// Each entry is the status the handler itself answers with — a 415 or a
// "invalid JSON body" 400 would mean the request never reached it.
const routes: Array<[string, string, number]> = [
  ['POST', '/api/git/pull', 200],
  ['POST', '/api/merge-queue/recheck', 200],
  ['POST', '/api/runs/missing-run/cancel', 404],
  ['POST', '/api/runs/missing-run/resume', 404],
  ['POST', '/api/notes/missing-note/promote', 404],
  ['DELETE', '/api/notes/missing-note', 404],
  ['DELETE', '/api/tasks/drafts/missing-draft', 404],
];

describe('body-less writes carrying a declared content-type reach the handler', () => {
  for (const [method, path, status] of routes) {
    it(`${method} ${path} answers ${status}`, async () => {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(status);
    });
  }
});
