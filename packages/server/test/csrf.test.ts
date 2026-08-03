import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import { FakePlanner } from '../src/orchestrator/planners/fake.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// `Response.json()` types as `Promise<unknown>` under this repo's DOM-less
// tsconfig — same escape hatch the other API suites use.
function json(res: Response): Promise<any> {
  return res.json();
}

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-csrf-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

// The origin a page on the open web presents. Nothing served from here may
// ever reach a handler.
const HOSTILE = 'https://evil.example';

// Every state-changing route that reaches its handler without reading a body,
// so a cross-origin POST to one is a CORS simple request: no preflight.
const BODYLESS_POST_ROUTES = [
  '/api/runs/r-1/resume',
  '/api/runs/r-1/cancel',
  '/api/git/pull',
  '/api/git/commit-message',
  '/api/tasks/t-1/enrich',
  '/api/notes/nt-1/enrich',
  '/api/inbox/ib-1/enrich',
  '/api/inbox/cluster',
  '/api/merge-queue/ready',
  '/api/merge-queue/recheck',
  '/api/epics/t-1/stop',
  '/api/linear/disconnect',
  '/api/linear/import',
  '/api/notes/nt-1/promote',
];

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
    webDistDir: null,
    writeDaemonFile: false,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor(
        'claude',
        new FakeExecutor({
          steps: [],
          finish: { state: 'finished', costUsd: 0, turns: 1 },
        })
      );
    },
    registerPlanners: (planManager) => {
      planManager.registerPlanner(
        'claude',
        new FakePlanner({ ok: true, proposal: null })
      );
    },
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

// Exactly what `fetch(url, { method: 'POST', mode: 'no-cors' })` from a hostile
// page puts on the wire: no body, no content-type, a foreign Origin.
function hostilePost(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { origin: HOSTILE },
  });
}

describe('cross-origin state changes', () => {
  it('rejects a body-less POST to every route that never reads a body', async () => {
    for (const path of BODYLESS_POST_ROUTES) {
      const res = await hostilePost(path);
      expect(`${path} -> ${res.status}`).toBe(`${path} -> 403`);
      expect((await json(res)).error).toBe('cross-origin request rejected');
    }
  });

  it('turns resume away before it can look the run up, let alone spawn one', async () => {
    // An unknown run id 404s once the handler runs, so a 403 here is proof the
    // request never reached the orchestrator.
    const res = await hostilePost('/api/runs/does-not-exist/resume');
    expect(res.status).toBe(403);
  });

  it('leaves a note unpromoted when a hostile page posts to promote', async () => {
    const created = await fetch(`${baseUrl}/api/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'todo', title: 'csrf target', body: '' }),
    });
    const note = await json(created);

    expect((await hostilePost(`/api/notes/${note.id}/promote`)).status).toBe(
      403
    );

    const notes = await json(await fetch(`${baseUrl}/api/notes`));
    expect(notes[0].linkedTaskId).toBeNull();
    const tasks = await json(await fetch(`${baseUrl}/api/tasks`));
    expect(tasks).toEqual([]);
  });

  it('rejects a cross-origin request that does carry a JSON body', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: HOSTILE },
      body: JSON.stringify({ title: 'planted' }),
    });
    expect(res.status).toBe(403);
    expect(await json(await fetch(`${baseUrl}/api/tasks`))).toEqual([]);
  });

  it('rejects cross-origin DELETE and PATCH as well as POST', async () => {
    const remove = await fetch(`${baseUrl}/api/merge-queue/mq-1`, {
      method: 'DELETE',
      headers: { origin: HOSTILE },
    });
    expect(remove.status).toBe(403);

    const patch = await fetch(`${baseUrl}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: HOSTILE },
      body: JSON.stringify({ linear: { enabled: true } }),
    });
    expect(patch.status).toBe(403);
  });

  it('rejects the opaque `null` origin a sandboxed frame sends', async () => {
    const res = await fetch(`${baseUrl}/api/merge-queue/recheck`, {
      method: 'POST',
      headers: { origin: 'null' },
    });
    expect(res.status).toBe(403);
  });
});

describe('legitimate clients', () => {
  // The desktop webview and the browser dev harness both send body-less POSTs
  // with no content-type, so the guard has to key on the origin, not the body.
  it.each([
    ['packaged webview', 'tauri://localhost'],
    ['webview on https', 'https://tauri.localhost'],
    ['vite dev server', 'http://localhost:5173'],
  ])('allows a body-less POST from the %s', async (_name, origin) => {
    const res = await fetch(`${baseUrl}/api/merge-queue/recheck`, {
      method: 'POST',
      headers: { origin },
    });
    expect(res.status).toBe(200);
  });

  it('allows the CLI and MCP server, which send no origin at all', async () => {
    const res = await fetch(`${baseUrl}/api/merge-queue/recheck`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
  });

  it('allows the daemon its own same-origin requests', async () => {
    const res = await fetch(`${baseUrl}/api/merge-queue/recheck`, {
      method: 'POST',
      headers: { origin: baseUrl },
    });
    expect(res.status).toBe(200);
  });

  it('still serves cross-origin reads, which CORS already keeps unreadable', async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: { origin: HOSTILE },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
