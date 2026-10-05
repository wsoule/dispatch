import { TaskStore } from '@dispatch-foo/core';
import { afterAll, beforeAll, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { initGitRepoAt } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

const appendix = readFileSync(
  new URL('../../protocol-spec/spec/appendix-a-daemon-api.md', import.meta.url),
  'utf8'
);

// Each table row whose first two cells are a method and a path, both in code.
const ROUTES = [
  ...appendix.matchAll(
    /^\| `(GET|POST|PUT|PATCH|DELETE)` +\| `(\/[^`]+)` +\|/gm
  ),
].map((m) => ({ method: m[1] ?? 'GET', path: m[2] ?? '' }));

const PARAMS: Record<string, string> = {
  ':id': 'm-probe',
  ':name': 'probe',
  ':addr': encodeURIComponent('agent:test/probe'),
};

// ActorContext writes a known-handle file under DISPATCH_HOME at boot; point
// it at a temp dir so the real ~/.dispatch is untouched.
const originalDispatchHome = process.env.DISPATCH_HOME;
let fakeHome = '';
let root = '';
let handle: ServerHandle;

beforeAll(async () => {
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'dmp-appendix-a-home-')));
  process.env.DISPATCH_HOME = fakeHome;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dmp-appendix-a-')));
  initGitRepoAt(root);
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
  });
  useTestAuth(handle);
});

afterAll(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// One way only: every documented route is one the daemon serves. The daemon
// has no route table to enumerate, so an undocumented route is left to review.
it('documents routes the daemon actually serves', async () => {
  expect(ROUTES.length).toBeGreaterThan(10);
  for (const { method, path } of ROUTES) {
    const concrete = path.replace(/:[a-z]+/g, (p) => PARAMS[p] ?? 'probe');
    const res = await fetch(`http://127.0.0.1:${handle.port}${concrete}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    });
    const body =
      res.status === 404
        ? await (res.json() as Promise<{ error?: string }>)
        : {};
    expect({
      method,
      path,
      unmatched: body.error === `not found: ${concrete.split('?')[0]}`,
    }).toEqual({ method, path, unmatched: false });
  }
});
