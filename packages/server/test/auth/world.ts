import { afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { initGitRepo, StallingExecutor } from '../orchestrator/helpers.js';
import { rawFetch } from '../testAuth.js';

// One in-process daemon per test with a stalling executor, for the identity
// and authorization suites under test/auth/: who a credential acts as, what a
// revoked teammate keeps, and who hears what.

export interface World {
  handle: ServerHandle;
  base: string;
  root: string;
  home: string;
  executor: StallingExecutor;
  app: string;
  agent: string;
}

export interface Reply {
  status: number;
  json: any;
  text: string;
}

/** Registers a fresh daemon per test and returns a getter for it. */
export function useWorld(
  opts: { writeDaemonFile?: boolean } = {}
): () => World {
  let w: World | undefined;
  const originalHome = process.env.DISPATCH_HOME;
  beforeEach(async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'auth-home-')));
    process.env.DISPATCH_HOME = home;
    const root = realpathSync(initGitRepo('auth-root-'));
    const executor = new StallingExecutor();
    const handle = await startServer({
      rootDir: root,
      port: 0,
      webDistDir: null,
      writeDaemonFile: opts.writeDaemonFile ?? false,
      registerExecutors: (o) => o.registerExecutor('claude', executor),
    });
    w = {
      handle,
      base: `http://127.0.0.1:${handle.port}`,
      root,
      home,
      executor,
      app: handle.tokens.appToken,
      agent: handle.tokens.agentToken,
    };
  });
  afterEach(async () => {
    if (w !== undefined) {
      await w.handle.stop();
      rmSync(w.home, { recursive: true, force: true });
      rmSync(w.root, { recursive: true, force: true });
    }
    w = undefined;
    if (originalHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalHome;
  });
  return () => {
    if (w === undefined) throw new Error('no world');
    return w;
  };
}

/** One JSON request as `token` (null sends none). */
export async function call(
  w: World,
  token: string | null,
  method: string,
  path: string,
  body?: unknown
): Promise<Reply> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await rawFetch(`${w.base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

/** Invites a teammate with the owner's app token. */
export async function invite(
  w: World,
  email: string,
  tier: 'request' | 'decide' | 'operator'
): Promise<{ handle: string; token: string }> {
  const r = await call(w, w.app, 'POST', '/api/team/tokens', { email, tier });
  if (r.status !== 201)
    throw new Error(`invite ${email}: ${r.status} ${r.text}`);
  return { handle: r.json.handle, token: r.json.token };
}

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 4000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

/** Dispatches `taskId` as `token` and waits for the run to go live. */
export async function startRun(
  w: World,
  token: string,
  taskId: string
): Promise<{ runId: string; runToken: string; meta: any }> {
  const before = w.executor.started.length;
  const r = await call(w, token, 'POST', `/api/tasks/${taskId}/runs`, {
    executor: 'claude',
  });
  if (r.status >= 300) throw new Error(`run: ${r.status} ${r.text}`);
  await waitFor(() => w.executor.started.length > before);
  await waitFor(
    () =>
      w.handle.orchestrator.list().find((x) => x.id === r.json.id)?.state ===
      'running'
  );
  const runToken = w.executor.runTokens[before];
  if (runToken === undefined) throw new Error('no run token');
  return { runId: r.json.id, runToken, meta: r.json };
}

/** Creates a task and dispatches it as `token`, returning its live run. */
export async function liveRun(
  w: World,
  token: string,
  title = 'task'
): Promise<{ runId: string; taskId: string; runToken: string }> {
  const t = await call(w, token, 'POST', '/api/tasks', { title });
  if (t.status >= 300) throw new Error(`task: ${t.status} ${t.text}`);
  const taskId = t.json.meta.id as string;
  const run = await startRun(w, token, taskId);
  return { runId: run.runId, taskId, runToken: run.runToken };
}
