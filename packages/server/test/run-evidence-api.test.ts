import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-run-evidence-api-'));
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
let runId: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor(
        'fake',
        new FakeExecutor({ finish: { state: 'finished' } })
      );
    },
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
  const taskRes = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'harden the sync path' }),
  });
  taskId = (await json<{ meta: { id: string } }>(taskRes)).meta.id;
  const runRes = await fetch(`${baseUrl}/api/tasks/${taskId}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ executor: 'fake' }),
  });
  runId = (await json<{ id: string }>(runRes)).id;
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function postEvidence(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/runs/${runId}/evidence`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postMutation(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/runs/${runId}/mutations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/runs/:id/evidence', () => {
  it('records a command and returns the stamped record', async () => {
    const res = await postEvidence({
      command: 'bun test',
      exitCode: 0,
      durationMs: 4200,
      summary: '158 pass, 0 fail',
    });
    expect(res.status).toBe(201);
    const evidence = await json<{ command: string; at: string }>(res);
    expect(evidence.command).toBe('bun test');
    expect(evidence.at).toBeTruthy();

    const detail = await json<{ evidence: { command: string }[] }>(
      await fetch(`${baseUrl}/api/runs/${runId}`)
    );
    expect(detail.evidence).toEqual([evidence]);
  });

  it('400s an empty command', async () => {
    const res = await postEvidence({
      command: '  ',
      exitCode: 0,
      durationMs: 1,
      summary: 'ok',
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toContain('command');
  });

  it('400s a non-integer exitCode', async () => {
    const res = await postEvidence({
      command: 'bun test',
      exitCode: 1.5,
      durationMs: 1,
      summary: 'ok',
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toContain('exitCode');
  });

  it('400s a negative durationMs', async () => {
    const res = await postEvidence({
      command: 'bun test',
      exitCode: 0,
      durationMs: -1,
      summary: 'ok',
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toContain('durationMs');
  });

  it('400s an empty summary', async () => {
    const res = await postEvidence({
      command: 'bun test',
      exitCode: 0,
      durationMs: 1,
      summary: '',
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toContain('summary');
  });

  it('404s an unknown run', async () => {
    const res = await fetch(`${baseUrl}/api/runs/r-000000/evidence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        command: 'bun test',
        exitCode: 0,
        durationMs: 1,
        summary: 'ok',
      }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/runs/:id/mutations', () => {
  it('records a mutation result, including testsFailed: 0', async () => {
    const res = await postMutation({
      guard: 'null check on foo()',
      file: 'src/foo.ts',
      testsFailed: 0,
    });
    expect(res.status).toBe(201);
    const mutation = await json<{
      guard: string;
      testsFailed: number;
      at: string;
    }>(res);
    expect(mutation.testsFailed).toBe(0);
    expect(mutation.at).toBeTruthy();

    const detail = await json<{
      mutations: { guard: string; testsFailed: number; at: string }[];
    }>(await fetch(`${baseUrl}/api/runs/${runId}`));
    expect(detail.mutations).toEqual([mutation]);
  });

  it('400s an empty guard', async () => {
    const res = await postMutation({ guard: '', file: 'f.ts', testsFailed: 1 });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toContain('guard');
  });

  it('400s an empty file', async () => {
    const res = await postMutation({
      guard: 'g',
      file: '  ',
      testsFailed: 1,
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toContain('file');
  });

  it('400s a negative testsFailed', async () => {
    const res = await postMutation({
      guard: 'g',
      file: 'f.ts',
      testsFailed: -1,
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toContain('testsFailed');
  });

  it('404s an unknown run', async () => {
    const res = await fetch(`${baseUrl}/api/runs/r-000000/mutations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ guard: 'g', file: 'f.ts', testsFailed: 1 }),
    });
    expect(res.status).toBe(404);
  });
});
