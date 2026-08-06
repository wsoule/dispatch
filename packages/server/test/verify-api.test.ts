import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type {
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
} from '../src/orchestrator/types.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// Answers a verify dispatch by writing `output` to the result path the
// rubric named, then finishing — no Agent SDK involved.
class ScriptedVerifier implements Executor {
  constructor(private readonly output: string) {}

  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    const match = /as one JSON object: (\S+)/.exec(opts.prompt);
    setTimeout(() => {
      try {
        if (match !== null) writeFileSync(match[1], this.output);
      } catch {
        // The run directory can be torn down before this fires; the finish
        // below still has to happen so nothing hangs.
      }
      events.onFinish({ state: 'finished' });
    }, 0);
    return {
      interrupt: async () => {},
      requestStop: () => {},
      send: () => {},
      approve: () => {},
    };
  }
}

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor timed out');
}

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-verify-api-'));
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
let taskId: string;
let head: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  const store = TaskStore.init(root);
  taskId = store.create({ title: 'harden the sync path' }).meta.id;
  head = runGitSync(root, ['rev-parse', 'HEAD']).trim();
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function startVerify(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/tasks/${taskId}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/tasks/:id/verify', () => {
  it('200s a skip when the project has no verify config', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await startVerify({ head });
    expect(res.status).toBe(200);
    expect(await json<{ skipped: boolean; reason: string }>(res)).toEqual({
      skipped: true,
      reason: expect.any(String),
    });
  });

  it('202s with the run and records a result once the project has a verify config', async () => {
    appendFileSync(
      join(root, '.dispatch', 'config.yml'),
      'verify:\n  command: bun run dev\n'
    );
    const verifier = new ScriptedVerifier(
      JSON.stringify({
        checks: [
          {
            check: 'load the app',
            expected: 'renders the dashboard',
            actual: 'rendered the dashboard',
            pass: true,
          },
        ],
        artifacts: ['shot.png'],
      })
    );
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      registerExecutors: (orchestrator) => {
        orchestrator.registerExecutor('claude', verifier);
      },
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await startVerify({ head });
    expect(res.status).toBe(202);
    const meta = await json<{ id: string; kind: string }>(res);
    expect(meta.kind).toBe('verify');

    await waitFor(async () => {
      const check = await fetch(`${baseUrl}/api/tasks/${taskId}/verification`);
      return check.status === 200;
    });
    const result = await json<{ pass: boolean; artifacts: string[] }>(
      await fetch(`${baseUrl}/api/tasks/${taskId}/verification`)
    );
    expect(result.pass).toBe(true);
    expect(result.artifacts).toEqual(['shot.png']);

    const task = await json<{ meta: { exercised: boolean } }>(
      await fetch(`${baseUrl}/api/tasks/${taskId}`)
    );
    expect(task.meta.exercised).toBe(true);
  });

  it('400s a missing head', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;
    expect((await startVerify({})).status).toBe(400);
  });

  it('404s an unknown task', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;
    const res = await fetch(`${baseUrl}/api/tasks/t-000000/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ head }),
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/tasks/:id/verification', () => {
  it('404s when no verify run has ever produced a result', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/verification`);
    expect(res.status).toBe(404);
  });
});
