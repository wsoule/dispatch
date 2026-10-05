import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeAiTaskFilter } from '../src/aiTaskFilter.js';
import type { AiTaskFilterPort } from '../src/aiTaskFilter.js';
import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import { FakePlanner } from '../src/orchestrator/planners/fake.js';
import { json } from './json.js';
import { runGitSync } from './orchestrator/helpers.js';
import { rawFetch, useTestAuth } from './testAuth.js';

// POST /api/tasks/filter/ai through a real daemon with the port injected:
// the route is reachable (and never read as a task id), the fake's keyword
// table comes back as clauses, and the guards answer their statuses.

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-ai-filter-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

class ThrowingAiTaskFilter implements AiTaskFilterPort {
  toFilters(): Promise<never> {
    return Promise.reject(new Error('model unavailable'));
  }
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

async function boot(aiTaskFilter: AiTaskFilterPort): Promise<void> {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    aiTaskFilter,
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
}

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function post(sentence: unknown, doFetch = fetch): Promise<Response> {
  return doFetch(`${baseUrl}/api/tasks/filter/ai`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sentence }),
  });
}

describe('POST /api/tasks/filter/ai', () => {
  beforeEach(() => boot(new FakeAiTaskFilter()));

  it('turns a sentence into filter clauses through the injected port', async () => {
    const res = await post('urgent tasks nobody is on');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      clauses: [
        { facet: 'priority', op: 'is', values: ['urgent'] },
        { facet: 'assignee', op: 'is', values: ['none'] },
      ],
      join: 'and',
    });
  });

  it('answers 400 on a blank sentence', async () => {
    expect((await post('   ')).status).toBe(400);
    expect((await post(undefined)).status).toBe(400);
  });

  it('answers 401 without a bearer', async () => {
    expect((await post('urgent', rawFetch)).status).toBe(401);
  });
});

describe('POST /api/tasks/filter/ai with a failing port', () => {
  beforeEach(() => boot(new ThrowingAiTaskFilter()));

  it('answers 502 with the port error', async () => {
    const res = await post('urgent');
    expect(res.status).toBe(502);
    expect((await json(res)).error).toBe('model unavailable');
  });
});
