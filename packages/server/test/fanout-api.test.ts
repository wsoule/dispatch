import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import { json } from './json.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-fanout-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial']);
  return dir;
}

function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type'))
    headers.set('content-type', 'application/json');
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

async function createTask(title: string, body: string): Promise<string> {
  const doc = await json(
    await apiFetch('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title, description: body, writes: ['src/**'] }),
    })
  );
  return doc.meta.id as string;
}

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initRepo();
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerExecutors: (orchestrator) => {
      // A script that finishes immediately: this suite is about how many runs
      // are started and how they are grouped, not what an agent writes.
      const script = { steps: [], finish: { state: 'finished' as const } };
      orchestrator.registerExecutor('claude', new FakeExecutor(script));
      orchestrator.registerExecutor('codex', new FakeExecutor(script));
      orchestrator.registerExecutor('gemini', new FakeExecutor(script));
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

describe('POST /api/tasks/:id/fanout', () => {
  it('starts one task and one run per agent', async () => {
    const taskId = await createTask('Fix login', 'Passwords are rejected.');
    const res = await apiFetch(`/api/tasks/${taskId}/fanout`, {
      method: 'POST',
      body: JSON.stringify({ variants: ['claude', 'codex', 'gemini'] }),
    });
    expect(res.status).toBe(201);
    const result = await json(res);

    expect(result.variants).toHaveLength(3);
    expect(result.label).toBe(`fanout:${taskId}`);
    for (const variant of result.variants) {
      expect(variant.run).not.toBeNull();
      expect(variant.error).toBeUndefined();
      expect(variant.task.meta.labels).toContain(`fanout:${taskId}`);
    }

    // Each variant got its own worktree and branch, which is what makes them
    // comparable side by side.
    const branches = result.variants.map(
      (v: { run: { branch: string } }) => v.run.branch
    );
    expect(new Set(branches).size).toBe(3);
    const worktrees = result.variants.map(
      (v: { run: { worktreePath: string } }) => v.run.worktreePath
    );
    expect(new Set(worktrees).size).toBe(3);
  });

  it('hands every agent the same problem statement', async () => {
    const taskId = await createTask('Fix login', 'Passwords are rejected.');
    const result = await json(
      await apiFetch(`/api/tasks/${taskId}/fanout`, {
        method: 'POST',
        body: JSON.stringify({ variants: ['claude', 'codex'] }),
      })
    );
    for (const variant of result.variants) {
      expect(variant.task.body).toContain('Passwords are rejected.');
      expect(variant.task.meta.writes).toEqual(['src/**']);
    }
  });

  it('names the agent in each clone’s title', async () => {
    const taskId = await createTask('Fix login', 'body');
    const result = await json(
      await apiFetch(`/api/tasks/${taskId}/fanout`, {
        method: 'POST',
        body: JSON.stringify({
          variants: ['claude', { executor: 'codex', model: 'gpt-5.5' }],
        }),
      })
    );
    const titles = result.variants.map(
      (v: { task: { meta: { title: string } } }) => v.task.meta.title
    );
    expect(titles).toEqual([
      'Fix login [claude]',
      'Fix login [codex · gpt-5.5]',
    ]);
  });

  it('leaves the source task untouched', async () => {
    // The original is the thing being compared against, not one of the
    // candidates — fanning out must not start a run on it.
    const taskId = await createTask('Fix login', 'body');
    await apiFetch(`/api/tasks/${taskId}/fanout`, {
      method: 'POST',
      body: JSON.stringify({ variants: ['claude', 'codex'] }),
    });
    const runs = await json(await apiFetch('/api/runs'));
    expect(
      runs.filter((run: { taskId: string }) => run.taskId === taskId)
    ).toEqual([]);
  });

  it('makes the group findable by its label', async () => {
    const taskId = await createTask('Fix login', 'body');
    await apiFetch(`/api/tasks/${taskId}/fanout`, {
      method: 'POST',
      body: JSON.stringify({ variants: ['claude', 'codex'] }),
    });
    const tasks = await json(await apiFetch('/api/tasks'));
    const grouped = tasks.filter((task: { meta: { labels: string[] } }) =>
      task.meta.labels.includes(`fanout:${taskId}`)
    );
    expect(grouped).toHaveLength(2);
  });

  it('404s an unknown task', async () => {
    const res = await apiFetch('/api/tasks/nope/fanout', {
      method: 'POST',
      body: JSON.stringify({ variants: ['claude'] }),
    });
    expect(res.status).toBe(404);
  });

  it('400s an unknown executor and says what is available', async () => {
    const taskId = await createTask('Fix login', 'body');
    const res = await apiFetch(`/api/tasks/${taskId}/fanout`, {
      method: 'POST',
      body: JSON.stringify({ variants: ['claude', 'nonesuch'] }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('claude');
  });

  it('400s duplicates and an empty list', async () => {
    const taskId = await createTask('Fix login', 'body');
    for (const variants of [[], ['claude', 'claude']]) {
      const res = await apiFetch(`/api/tasks/${taskId}/fanout`, {
        method: 'POST',
        body: JSON.stringify({ variants }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('creates nothing when validation fails', async () => {
    // A rejected request must not leave half a fan-out behind.
    const taskId = await createTask('Fix login', 'body');
    const before = (await json(await apiFetch('/api/tasks'))).length;
    await apiFetch(`/api/tasks/${taskId}/fanout`, {
      method: 'POST',
      body: JSON.stringify({ variants: ['claude', 'nonesuch'] }),
    });
    expect((await json(await apiFetch('/api/tasks'))).length).toBe(before);
  });

  it('"fanout" is never read as a run id', async () => {
    // The literal is matched before the `:id` sub-routes, so this must reach
    // the fan-out handler rather than the run lookup.
    const taskId = await createTask('Fix login', 'body');
    const res = await apiFetch(`/api/tasks/${taskId}/fanout`, {
      method: 'POST',
      body: JSON.stringify({ variants: ['claude'] }),
    });
    expect(res.status).toBe(201);
  });
});
