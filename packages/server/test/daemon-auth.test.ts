import { TaskStore } from '@dispatch-foo/core';
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
    registerExecutors: () => {},
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

// Registers an agent with the shared agent token and returns its address: a
// pending registration is the state a decide-tier approval acts on.
async function pendingAgent(): Promise<string> {
  const registered = await json<{ address: string }>(
    await rawFetch(`${baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: auth(agentToken),
      body: JSON.stringify({ name: 'reviewer', client: 'codex' }),
    })
  );
  return registered.address;
}

function decide(address: string, token: string | null): Promise<Response> {
  return rawFetch(
    `${baseUrl}/api/agents/${encodeURIComponent(address)}/approve`,
    { method: 'POST', headers: auth(token) }
  );
}

// The roster status of one registered agent.
async function agentStatus(address: string): Promise<string | undefined> {
  const roster = await json<{ agents: { address: string; status: string }[] }>(
    await rawFetch(`${baseUrl}/api/agents/roster`, {
      headers: auth(agentToken),
    })
  );
  return roster.agents.find((agent) => agent.address === address)?.status;
}

describe('open routes', () => {
  it('serves GET /api/health without a token, so discovery still works', async () => {
    const res = await rawFetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect((await json<{ ok: boolean }>(res)).ok).toBe(true);
  });
});

interface HealthIdentity {
  ok: boolean;
  identity: 'ok' | 'displaced' | 'unregistered';
  problems: string[];
}

function health(): Promise<HealthIdentity> {
  return rawFetch(`${baseUrl}/api/health`).then((res) =>
    json<HealthIdentity>(res)
  );
}

// On 2026-09-07 three daemons served one root and only `ps` could tell;
// health is the one route every client probes, so it is where a displaced
// daemon says so.
describe('daemon identity at GET /api/health', () => {
  it('reports ok while the daemon file still names this process', async () => {
    const body = await health();
    expect(body.identity).toBe('ok');
    expect(body.problems).toEqual([]);
  });

  it('reports displaced once another pid has rewritten the daemon file', async () => {
    const prior = readDaemonFile(root);
    expect(prior).not.toBeNull();
    const otherPid = process.pid + 100000;
    writeFileSync(
      daemonFilePath(root),
      JSON.stringify({
        ...prior,
        pid: otherPid,
        startedAt: '2026-09-07T10:00:00.000Z',
      })
    );
    const body = await health();
    expect(body.ok).toBe(true);
    expect(body.identity).toBe('displaced');
    expect(body.problems).toHaveLength(1);
    expect(body.problems[0]).toContain(`pid ${otherPid}`);
    expect(body.problems[0]).toContain('2026-09-07T10:00:00.000Z');
    expect(body.problems[0]).toContain(`pid ${process.pid}`);
    // Written by the test, not this daemon: removeDaemonFile would refuse to
    // clear it at stop(), so restore ownership for the afterEach cleanup.
    writeFileSync(daemonFilePath(root), JSON.stringify(prior));
  });

  it('reports unregistered once the daemon file is gone', async () => {
    rmSync(daemonFilePath(root));
    const body = await health();
    expect(body.ok).toBe(true);
    expect(body.identity).toBe('unregistered');
    expect(body.problems).toEqual([
      "this project's daemon file is gone; clients will spawn a second daemon on their next call",
    ]);
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
    // Someone holding a stale app token is told which line it comes from.
    expect(body.error).toContain('DISPATCH_APP_TOKEN line');
  });

  it('says an invite link is not a daemon token, in every form', async () => {
    for (const invite of [
      'dispatch-team:payload',
      'https://dispatch.foo/join#payload',
      'di1.abc',
    ]) {
      const res = await rawFetch(`${baseUrl}/api/tasks`, {
        headers: auth(invite),
      });
      expect(res.status).toBe(401);
      const body = await json<AuthError>(res);
      expect(body.code).toBe('auth_invalid_token');
      expect(body.error).toStartWith('that is a team invite link');
      expect(body.error).not.toContain(invite);
    }
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
    const address = await pendingAgent();
    const res = await decide(address, agentToken);
    expect(res.status).toBe(403);
    const body = await json<AuthError>(res);
    expect(body.code).toBe('auth_insufficient_tier');
    expect(body.error).toContain('DISPATCH_APP_TOKEN');

    // The refusal must leave no trace: an agent approving itself onto the
    // roster is the whole thing being prevented.
    expect(await agentStatus(address)).toBe('pending');
  });

  it('401s a decision made with no token at all', async () => {
    const address = await pendingAgent();
    const res = await decide(address, null);
    expect(res.status).toBe(401);
    expect((await json<AuthError>(res)).code).toBe('auth_missing_token');
  });

  it('lets the app token through and records the decision', async () => {
    const address = await pendingAgent();
    const res = await decide(address, appToken);
    expect(res.status).toBe(200);
    expect(await agentStatus(address)).toBe('approved');
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

  it('marks only a daemon with an idle timeout as background, with who started it', async () => {
    expect(readDaemonFile(root)?.background).toBeUndefined();
    await handle.stop();
    handle = await startServer({
      rootDir: root,
      port: 0,
      webDistDir: null,
      writeDaemonFile: true,
      registerExecutors: () => {},
      idleTimeoutMs: 60_000,
      onIdle: () => {},
      startedBy: 'dispatch mcp (pid 1)',
    });
    expect(readDaemonFile(root)).toMatchObject({
      background: true,
      startedBy: 'dispatch mcp (pid 1)',
    });
  });

  it('never writes the app token anywhere under the dispatch home', () => {
    const carrying = filesUnder(fakeHome).filter((path) =>
      readFileSync(path, 'utf8').includes(appToken)
    );
    expect(carrying).toEqual([]);
  });
});

describe('GET /api/whoami', () => {
  it('names who the credential speaks for, and its tier', async () => {
    // Both built-in tokens authenticate as the operator — the person whose
    // machine this daemon runs on — so a solo project is unchanged. What is
    // new is that the answer exists at all: presence, claims and attribution
    // all need a caller to be identifiable first.
    const asApp = await json<{ handle: string; ref: string; tier: string }>(
      await rawFetch(`${baseUrl}/api/whoami`, { headers: auth(appToken) })
    );
    expect(asApp.tier).toBe('operator');
    expect(asApp.ref).toBe(`human:${asApp.handle}`);

    const asAgent = await json<{ handle: string; tier: string }>(
      await rawFetch(`${baseUrl}/api/whoami`, { headers: auth(agentToken) })
    );
    expect(asAgent.tier).toBe('request');
    // Same person, different capability — the split that already existed.
    expect(asAgent.handle).toBe(asApp.handle);
  });

  it('401s without a credential rather than answering anonymously', async () => {
    const res = await rawFetch(`${baseUrl}/api/whoami`, {
      headers: auth(null),
    });
    expect(res.status).toBe(401);
  });
});

describe('handing the project to another daemon', () => {
  it('reports no live work on the agent token', async () => {
    const res = await rawFetch(`${baseUrl}/api/live-work`, {
      headers: auth(agentToken),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ busy: [], parked: [], waiting: 0 });
  });

  it('refuses to stop when its process cannot exit', async () => {
    const res = await rawFetch(`${baseUrl}/api/daemon/shutdown`, {
      method: 'POST',
      headers: auth(agentToken),
    });
    expect(res.status).toBe(409);
  });

  it('exits on its own agent token once idle, after answering', async () => {
    await handle.stop();
    let stopped = 0;
    handle = await startServer({
      rootDir: root,
      port: 0,
      webDistDir: null,
      writeDaemonFile: true,
      registerExecutors: () => {},
      onShutdownRequest: () => {
        stopped += 1;
      },
    });
    const res = await rawFetch(
      `http://127.0.0.1:${handle.port}/api/daemon/shutdown`,
      { method: 'POST', headers: auth(handle.tokens.agentToken) }
    );
    expect(res.status).toBe(202);
    expect(stopped).toBe(0);
    await Bun.sleep(300);
    expect(stopped).toBe(1);
  });
});
