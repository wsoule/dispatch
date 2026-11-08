import { TaskStore } from '@dispatch-foo/core';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { judgmentsFor, startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';
import { rawFetch, useTestAuth } from './testAuth.js';

// A daemon hosted for other people (app.dispatch.foo's planner) answers only
// the planning routes, whoever asks: even the operator's own token reaches no
// run, shell, browser, file, git, preview or network route.

const PLANNER_ROUTES: [string, string, unknown?][] = [
  ['GET', '/api/whoami'],
  ['GET', '/api/config'],
  ['GET', '/api/people'],
  ['GET', '/api/tasks?archived=1&fields=meta'],
  ['GET', '/api/tasks/readiness'],
  ['GET', '/api/planning/audit'],
  ['GET', '/api/planning/digests'],
  ['GET', '/api/planning/allocation-runs'],
  ['GET', '/api/milestones/progress'],
  ['GET', '/api/linear/status'],
  ['GET', '/api/runs'],
  ['GET', '/api/executors'],
];

const CLOSED_ROUTES: [string, string, unknown?][] = [
  ['GET', '/api/terminals'],
  ['POST', '/api/terminals', {}],
  ['POST', '/api/browser/open', { url: 'https://example.com' }],
  ['GET', '/api/files?path=.'],
  ['GET', '/api/files/raw?path=README.md'],
  ['POST', '/api/files/write', { path: 'x', content: 'y' }],
  ['GET', '/api/branches'],
  ['GET', '/api/landing'],
  ['POST', '/api/tasks/filter/ai', { query: 'mine' }],
  ['POST', '/api/tasks/draft', { prompt: 'x' }],
  ['GET', '/api/overseer/current'],
  ['GET', '/api/docs'],
  ['GET', '/api/threads'],
  ['GET', '/api/a2a/peers'],
  ['POST', '/api/plan', { prompt: 'x' }],
  ['POST', '/api/setup/agent-key', { provider: 'anthropic', apiKey: 'x' }],
  ['POST', '/api/daemon/shutdown', {}],
  ['GET', '/preview/anything'],
  ['POST', '/api/linear/connect', { apiKey: 'lin_api_attacker_key_000000000' }],
  ['POST', '/api/linear/disconnect', {}],
  ['HEAD', '/api/team/tokens'],
];

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let base: string;
let taskId: string;
const originalHome = process.env.DISPATCH_HOME;

function call(method: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
}

beforeAll(async () => {
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-home-')));
  process.env.DISPATCH_HOME = fakeHome;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-hosted-')));
  runGitSync(root, ['init', '-b', 'main']);
  runGitSync(root, ['config', 'user.email', 'test@example.com']);
  runGitSync(root, ['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'README.md'), '# test repo\n');
  runGitSync(root, ['add', '-A']);
  runGitSync(root, ['commit', '-m', 'initial commit']);
  TaskStore.init(root);
  const ui = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-hosted-ui-')));
  writeFileSync(join(ui, 'index.html'), '<html>app</html>');
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    hubLink: false,
    hostedPlanner: true,
    // Even given a UI, a hosted planner serves none (its page carries a token).
    webDistDir: ui,
  });
  useTestAuth(handle);
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('hosted planner mode', () => {
  it('answers the planning routes', async () => {
    for (const [method, path] of PLANNER_ROUTES) {
      const res = await call(method, path);
      expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 200`);
    }
  });

  it('edits tasks and comments', async () => {
    const created = await call('POST', '/api/tasks', {
      title: 'Plan the beta',
    });
    expect(created.status).toBe(201);
    taskId = ((await created.json()) as { meta: { id: string } }).meta.id;
    expect(
      (await call('PATCH', `/api/tasks/${taskId}`, { priority: 'high' })).status
    ).toBe(200);
    expect(
      (
        await call('POST', `/api/tasks/${taskId}/comments`, {
          body: 'Looks right.',
        })
      ).status
    ).toBe(201);
  });

  it('refuses every run, shell, file, git, preview and network route, even to the operator', async () => {
    for (const [method, path, body] of CLOSED_ROUTES) {
      const res = await call(method, path, body);
      expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 404`);
    }
    expect((await call('POST', `/api/tasks/${taskId}/runs`, {})).status).toBe(
      404
    );
    expect((await call('POST', `/api/tasks/${taskId}/review`, {})).status).toBe(
      404
    );
    expect((await call('POST', `/api/tasks/${taskId}/enrich`, {})).status).toBe(
      404
    );
  });

  it('registers no agent executor', async () => {
    const executors = (await (await call('GET', '/api/executors')).json()) as {
      executors: unknown[];
    };
    expect(executors.executors).toEqual([]);
  });

  it('never creates a judgment client, even with a TypeSafe key and one passed in', () => {
    const passed = {
      judge: () => Promise.resolve(null),
    } as unknown as Parameters<typeof judgmentsFor>[0]['judgments'];
    expect(
      judgmentsFor({ hostedPlanner: true, judgments: passed }, root)
    ).toBeNull();
    expect(judgmentsFor({ judgments: passed }, root) === passed).toBe(true);
  });

  it('serves no UI page, so no page hands out a token', async () => {
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/index.html`)).status).toBe(404);
  });

  it('answers setup and sync with fixed data instead of running commands', async () => {
    expect(await (await call('GET', '/api/setup')).json()).toEqual({
      steps: [],
      providers: [],
    });
    const sync = (await (await call('GET', '/api/sync')).json()) as {
      state: string;
    };
    expect(sync.state).toBe('disabled');
  });

  it('takes only planning, status, label and Linear-team settings, at any tier', async () => {
    for (const body of [
      { notifications: { webhook: 'https://evil.test/hook' } },
      { receipts: { repo: 'https://evil.test/r.git' } },
      { verifyCommand: 'curl evil.test' },
      { remotes: [] },
      { linear: { oauthClientId: 'attacker' } },
    ]) {
      const res = await call('PATCH', '/api/config', body);
      expect(`${JSON.stringify(body)} ${res.status}`).toBe(
        `${JSON.stringify(body)} 403`
      );
    }
    expect(
      (await call('PATCH', '/api/config', { linear: { intervalSec: 120 } }))
        .status
    ).toBe(200);
  });

  it("lets only the host mint or revoke members' tokens", async () => {
    const minted = await call('POST', '/api/team/tokens', {
      email: 'ada@example.com',
      displayName: 'Ada',
      tier: 'decide',
    });
    expect(minted.status).toBe(201);
    const { token } = (await minted.json()) as { token: string };
    const asAda = (method: string, path: string, body?: unknown) =>
      rawFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    expect((await asAda('GET', '/api/whoami')).status).toBe(200);
    expect(
      (
        await asAda('POST', '/api/team/tokens', {
          email: 'sock@example.com',
          displayName: 'Sock',
          tier: 'decide',
        })
      ).status
    ).toBe(404);
    expect((await asAda('GET', '/api/team/tokens')).status).toBe(404);
    expect((await asAda('DELETE', '/api/team/tokens/ada')).status).toBe(404);
  });
});
