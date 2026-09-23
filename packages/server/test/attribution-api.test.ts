import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { Executor, ExecutorRun } from '../src/orchestrator/types.js';
import { runGitSync } from './orchestrator/helpers.js';
import { rawFetch } from './testAuth.js';

// On a daemon two people use, a write must be credited to whoever made it.
// Before tokens named people every human write read as the operator's,
// because the operator was the only human there could be.

// Never finishes, so a dispatched run just sits there to be inspected.
const idle: Executor = {
  start() {
    return {
      interrupt: async () => {},
      requestStop: () => {},
      send: () => {},
      approve: () => {},
      notify: () => {},
    } satisfies ExecutorRun;
  },
};

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-attribution-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'wyat@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Wyat']);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial']);
  return dir;
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
let ada: string;
const originalHome = process.env.DISPATCH_HOME;

function headers(token: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };
}

async function post(path: string, token: string, body: object) {
  return rawFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body),
  });
}

async function newTask(token: string, title: string): Promise<string> {
  const res = await post('/api/tasks', token, { title });
  return ((await res.json()) as { meta: { id: string } }).meta.id;
}

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initRepo();
  TaskStore.init(root);
  // Committed so a run's worktree can branch from it.
  runGitSync(root, ['add', '-A']);
  runGitSync(root, ['commit', '-m', 'dispatch init']);
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('claude', idle);
    },
  });
  baseUrl = `http://127.0.0.1:${handle.port}`;
  const issued = await post('/api/team/tokens', handle.tokens.appToken, {
    email: 'ada@example.com',
    displayName: 'Ada',
  });
  ada = ((await issued.json()) as { token: string }).token;
});

afterEach(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('attribution on a shared daemon', () => {
  it("a teammate's finding is raised by them, not the operator", async () => {
    const taskId = await newTask(handle.tokens.appToken, 'Widget');
    const res = await post('/api/findings', ada, {
      taskId,
      severity: 'minor',
      title: 'Typo in the label',
      detail: 'Label is misspelled.',
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { raisedBy: string }).raisedBy).toBe(
      'human:ada'
    );
  });

  it("a teammate's activity note is credited to them", async () => {
    const taskId = await newTask(handle.tokens.appToken, 'Widget');
    await rawFetch(`${baseUrl}/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: headers(ada),
      body: JSON.stringify({ appendActivity: 'looked at this' }),
    });
    const task = (await (
      await rawFetch(`${baseUrl}/api/tasks/${taskId}`, {
        headers: headers(ada),
      })
    ).json()) as { body: string };
    expect(task.body).toContain('human:ada');
    expect(task.body).not.toContain('looked at this (human:wyat)');
  });

  it('a run records who dispatched it', async () => {
    const taskId = await newTask(handle.tokens.appToken, 'Widget');
    const res = await post(`/api/tasks/${taskId}/runs`, ada, {});
    expect(res.status).toBe(201);
    expect(((await res.json()) as { dispatchedBy?: string }).dispatchedBy).toBe(
      'human:ada'
    );
  });

  it('the operator is still credited as themselves', async () => {
    // Nothing changes for a solo project: the built-in pair names the
    // operator, exactly as every write was credited before.
    const taskId = await newTask(handle.tokens.appToken, 'Widget');
    const res = await post('/api/findings', handle.tokens.appToken, {
      taskId,
      severity: 'minor',
      title: 'Mine',
      detail: 'Operator note.',
    });
    expect(((await res.json()) as { raisedBy: string }).raisedBy).toBe(
      'human:wyat'
    );
  });

  it('a body cannot forge whose write it was', async () => {
    const taskId = await newTask(handle.tokens.appToken, 'Widget');
    const res = await post('/api/findings', ada, {
      taskId,
      severity: 'minor',
      title: 'Sneaky',
      detail: 'Pretends to be the operator.',
      raisedBy: 'human:wyat',
    });
    expect(((await res.json()) as { raisedBy: string }).raisedBy).toBe(
      'human:ada'
    );
  });
});
