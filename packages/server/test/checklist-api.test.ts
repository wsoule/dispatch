import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle, StartServerOptions } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { JudgmentClient } from '../src/judgments/client.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// A coding run that finishes gets a requirement checklist judged from its
// diff, served at GET /api/runs/:id/checklist and joined onto its landing
// row. Without a judgment client neither exists.

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-checklist-api-'));
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
let handle: ServerHandle | null = null;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  TaskStore.init(root);
});

afterEach(async () => {
  await handle?.stop();
  handle = null;
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// Says yes to a requirement whose text names a file the diff touched.
function diffAwareClient(): JudgmentClient {
  return {
    model: 'jev-test',
    judge: (state, questions) => {
      const { task, diff } = state as {
        task: { requirements: string[] };
        diff: { files: string[] };
      };
      const answers: Record<string, unknown> = {};
      for (const key of Object.keys(questions)) {
        if (key === 'scope_creep') {
          answers[key] = { type: 'noul', noul: 0.1 };
          continue;
        }
        const text = task.requirements[Number(key.slice('req_'.length))];
        const hit = diff.files.some((f) => text.includes(f));
        answers[key] = { type: 'noul', noul: hit ? 0.95 : 0.2 };
      }
      return Promise.resolve({
        model: 'jev-test',
        answers,
        usage: { input_tokens: 1, output_tokens: 0 },
      } as never);
    },
  };
}

async function boot(over: Partial<StartServerOptions>): Promise<void> {
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    judgments: null,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor(
        'claude',
        new FakeExecutor({
          steps: [
            {
              write: (cwd) =>
                writeFileSync(join(cwd, 'src.ts'), 'export {};\n'),
              commitMessage: 'add src.ts',
            },
          ],
          finish: { state: 'finished', costUsd: 0, turns: 1 },
        })
      );
    },
    ...over,
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('waitFor timed out');
}

async function dispatchAndFinish(): Promise<{ runId: string; taskId: string }> {
  const store = new TaskStore(root);
  const task = store.create({
    title: 'Add src.ts',
    status: 'ready',
    description: '- [ ] create src.ts\n- [ ] update the docs',
  });
  const res = await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(201);
  const run = (await res.json()) as { id: string };
  await waitFor(async () => {
    const r = await fetch(`${baseUrl}/api/runs/${run.id}`);
    const body = (await r.json()) as {
      meta?: { state: string };
      state?: string;
    };
    return (body.meta?.state ?? body.state) === 'finished';
  });
  return { runId: run.id, taskId: task.meta.id };
}

describe('run checklist', () => {
  it('is judged on finish, served per run, and joined onto the landing row', async () => {
    await boot({ judgments: diffAwareClient() });
    const { runId } = await dispatchAndFinish();

    await waitFor(
      async () =>
        (await fetch(`${baseUrl}/api/runs/${runId}/checklist`)).status === 200
    );
    const checklist = (await (
      await fetch(`${baseUrl}/api/runs/${runId}/checklist`)
    ).json()) as {
      passed: number;
      total: number;
      weak: string[];
      items: { text: string; probability: number }[];
    };
    expect(checklist.total).toBe(2);
    expect(checklist.passed).toBe(1);
    expect(checklist.weak).toEqual(['update the docs']);

    const landing = (await (await fetch(`${baseUrl}/api/landing`)).json()) as {
      rows: {
        runId?: string;
        checklist?: { passed: number; total: number; weak: string[] };
      }[];
    };
    const row = landing.rows.find((r) => r.runId === runId);
    expect(row?.checklist).toEqual({
      passed: 1,
      total: 2,
      weak: ['update the docs'],
    });
  });

  it('is absent without a judgment client', async () => {
    await boot({ judgments: null });
    const { runId } = await dispatchAndFinish();
    // Give a would-be hook the same window the judged case needed.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await fetch(`${baseUrl}/api/runs/${runId}/checklist`)).status).toBe(
      404
    );
    const landing = (await (await fetch(`${baseUrl}/api/landing`)).json()) as {
      rows: { runId?: string; checklist?: unknown }[];
    };
    const row = landing.rows.find((r) => r.runId === runId);
    expect(row).toBeDefined();
    expect(row?.checklist).toBeUndefined();
  });
});
