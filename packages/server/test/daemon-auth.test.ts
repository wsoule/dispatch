import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { daemonFilePath, readDaemonFile } from '../src/daemonfile.js';
import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { Executor, ExecutorRun } from '../src/orchestrator/types.js';
import { runGitSync } from './orchestrator/helpers.js';
import { rawFetch } from './testAuth.js';

// Every request here names the token it presents, so nothing in this file
// depends on testAuth.js's convenience injection.
function auth(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return headers;
}

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

interface AuthError {
  error: string;
  code: string;
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 20
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
}

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-daemon-auth-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

// Never calls onFinish, so a dispatched run stays `running` — the only state
// the scope-request routes accept one from.
const controllable: Executor = {
  start() {
    return {
      interrupt: async () => {},
      requestStop: () => {},
      send: () => {},
      approve: () => {},
    } satisfies ExecutorRun;
  },
};

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
let agentToken: string;
let appToken: string;
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
    // The daemon file is the point of several tests below, so this suite is
    // one of the few that lets the server write a real one.
    writeDaemonFile: true,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('claude', controllable);
    },
  });
  baseUrl = `http://127.0.0.1:${handle.port}`;
  agentToken = handle.tokens.agentToken;
  appToken = handle.tokens.appToken;
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// Dispatches a task, waits for its run to be `running`, and opens a scope
// request on it — the exact state a decide-tier call acts on.
async function liveScopeRequest(): Promise<{ runId: string; id: string }> {
  const task = await json<{ meta: { id: string } }>(
    await rawFetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: auth(agentToken),
      body: JSON.stringify({ title: 'Needs a shared export' }),
    })
  );
  const meta = await json<{ id: string }>(
    await rawFetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
      method: 'POST',
      headers: auth(agentToken),
      body: JSON.stringify({ executor: 'claude' }),
    })
  );
  await waitFor(async () => {
    const r = await json<{ meta: { state: string } }>(
      await rawFetch(`${baseUrl}/api/runs/${meta.id}`, {
        headers: auth(agentToken),
      })
    );
    return r.meta.state === 'running';
  });
  const record = await json<{ id: string }>(
    await rawFetch(`${baseUrl}/api/runs/${meta.id}/scope-requests`, {
      method: 'POST',
      headers: auth(agentToken),
      body: JSON.stringify({
        paths: ['packages/core/src/browser.ts'],
        reason: 'the scoped code needs a type this file never re-exports',
      }),
    })
  );
  return { runId: meta.id, id: record.id };
}

function decide(
  runId: string,
  requestId: string,
  token: string | null
): Promise<Response> {
  return rawFetch(
    `${baseUrl}/api/runs/${runId}/scope-requests/${requestId}/decide`,
    {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ granted: true, reason: 'looks fine' }),
    }
  );
}

describe('open routes', () => {
  it('serves GET /api/health without a token, so discovery still works', async () => {
    const res = await rawFetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect((await json<{ ok: boolean }>(res)).ok).toBe(true);
  });
});

describe('request tier', () => {
  it('401s a read with no token, and says where to find one', async () => {
    const res = await rawFetch(`${baseUrl}/api/tasks`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    const body = await json<AuthError>(res);
    expect(body.code).toBe('auth_missing_token');
    expect(body.error).toContain('~/.dispatch/daemons/');
  });

  it('401s a state change with no token', async () => {
    const res = await rawFetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: auth(null),
      body: JSON.stringify({ title: 'Unauthenticated' }),
    });
    expect(res.status).toBe(401);
    expect((await json<AuthError>(res)).code).toBe('auth_missing_token');
  });

  it('401s a token from some other daemon, and says to re-read the file', async () => {
    const res = await rawFetch(`${baseUrl}/api/tasks`, {
      headers: auth('f'.repeat(64)),
    });
    expect(res.status).toBe(401);
    const body = await json<AuthError>(res);
    expect(body.code).toBe('auth_invalid_token');
    expect(body.error).toContain('restarted daemon');
  });

  it('accepts the agent token', async () => {
    const res = await rawFetch(`${baseUrl}/api/tasks`, {
      headers: auth(agentToken),
    });
    expect(res.status).toBe(200);
  });

  it('accepts the app token, which outranks the agent token', async () => {
    const res = await rawFetch(`${baseUrl}/api/tasks`, {
      headers: auth(appToken),
    });
    expect(res.status).toBe(200);
  });

  it('still rejects a cross-origin state change that carries a valid token', async () => {
    // Origin and token are independent defences; neither substitutes for the
    // other, so a valid token must not buy a hostile page a write.
    const res = await rawFetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { ...auth(appToken), origin: 'https://evil.example' },
      body: JSON.stringify({ title: 'From a hostile page' }),
    });
    expect(res.status).toBe(403);
    expect((await json<{ error: string }>(res)).error).toBe(
      'cross-origin request rejected'
    );
  });
});

describe('decide tier', () => {
  it('403s a decision made with the agent token, and says how to get the app token', async () => {
    const { runId, id } = await liveScopeRequest();
    const res = await decide(runId, id, agentToken);
    expect(res.status).toBe(403);
    const body = await json<AuthError>(res);
    expect(body.code).toBe('auth_insufficient_tier');
    expect(body.error).toContain('DISPATCH_APP_TOKEN');

    // The refusal must leave no trace of a decision behind — a forged
    // justification in the record is the whole thing being prevented.
    const record = await json<{ granted: boolean | null }>(
      await rawFetch(`${baseUrl}/api/runs/${runId}/scope-requests/${id}`, {
        headers: auth(agentToken),
      })
    );
    expect(record.granted).toBeNull();
    const ledger = await json<{ kind: string }[]>(
      await rawFetch(`${baseUrl}/api/ledger`, { headers: auth(agentToken) })
    );
    expect(ledger.some((entry) => entry.kind === 'decision')).toBe(false);
  });

  it('401s a decision made with no token at all', async () => {
    const { runId, id } = await liveScopeRequest();
    const res = await decide(runId, id, null);
    expect(res.status).toBe(401);
    expect((await json<AuthError>(res)).code).toBe('auth_missing_token');
  });

  it('lets the app token through and records the decision', async () => {
    const { runId, id } = await liveScopeRequest();
    const res = await decide(runId, id, appToken);
    expect(res.status).toBe(200);
    expect((await json<{ granted: boolean }>(res)).granted).toBe(true);

    // The mirror of the agent-token case: the same read that shows nothing
    // after a refusal must show the entry after a real decision.
    const ledger = await json<{ kind: string; title: string }[]>(
      await rawFetch(`${baseUrl}/api/ledger`, { headers: auth(agentToken) })
    );
    expect(
      ledger.some(
        (entry) => entry.kind === 'decision' && entry.title.includes(runId)
      )
    ).toBe(true);
  });
});

describe('/ws upgrade', () => {
  // The HTTP view of the handshake, so the status code is observable.
  it('401s an upgrade with no token', async () => {
    const res = await rawFetch(`${baseUrl}/ws`);
    expect(res.status).toBe(401);
    expect((await json<AuthError>(res)).code).toBe('auth_missing_token');
  });

  it('401s an upgrade whose query token is wrong', async () => {
    const res = await rawFetch(`${baseUrl}/ws?token=${'f'.repeat(64)}`);
    expect(res.status).toBe(401);
    expect((await json<AuthError>(res)).code).toBe('auth_invalid_token');
  });

  it('opens for the agent token in the query string', async () => {
    const first = await new Promise<string | null>((resolve) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${handle.port}/ws?token=${agentToken}`
      );
      const settle = (value: string | null): void => {
        resolve(value);
        ws.close();
      };
      ws.addEventListener('message', (event) => {
        settle(String((event as MessageEvent).data));
      });
      ws.addEventListener('error', () => settle(null));
      ws.addEventListener('close', () => settle(null));
    });
    expect(JSON.parse(first ?? '{}').type).toBe('hello');
  });
});

// Every regular file under `dir`, so a token search covers the whole home.
function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

describe('token storage', () => {
  it('writes the agent token to a 0600 daemon file', () => {
    const path = daemonFilePath(root);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readDaemonFile(root)?.agentToken).toBe(agentToken);
  });

  it('never writes the app token anywhere under the dispatch home', () => {
    const carrying = filesUnder(fakeHome).filter((path) =>
      readFileSync(path, 'utf8').includes(appToken)
    );
    expect(carrying).toEqual([]);
  });
});
