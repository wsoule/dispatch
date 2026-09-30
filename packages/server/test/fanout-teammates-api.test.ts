import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import { json } from './json.js';
import { runGitSync } from './orchestrator/helpers.js';
import { licensedManager } from './team/licenseKeys.js';
import { rawFetch, useTestAuth } from './testAuth.js';

// POST /api/epics/:id/dispatch works for the caller: a fan-out a teammate
// starts on a shared daemon never picks up the operator's tasks, and one the
// operator starts never picks up a teammate's.

let fakeHome: string;
let root: string;
let store: TaskStore;
let handle: ServerHandle | null;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-fanout-team-'));
  runGitSync(root, ['init', '-b', 'main']);
  runGitSync(root, ['config', 'user.email', 'test@example.com']);
  runGitSync(root, ['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'README.md'), '# test repo\n');
  runGitSync(root, ['add', '-A']);
  runGitSync(root, ['commit', '-m', 'initial commit']);
  store = TaskStore.init(root);
  handle = null;
});

// Boots the daemon over the tasks already on disk: the HTTP API takes only
// the bare assignee kinds, so person refs (as Linear sync writes them) go in
// through the store first.
async function boot(): Promise<ServerHandle> {
  const started = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerExecutors: (orchestrator) => {
      // Parks every run at an approval gate, so each stays live.
      orchestrator.registerExecutor(
        'fake',
        new FakeExecutor({
          steps: [
            { approval: { requestId: 'go', toolName: 'noop', input: {} } },
          ],
          finish: { state: 'finished', costUsd: 0, turns: 1 },
        })
      );
    },
  });
  useTestAuth(started);
  baseUrl = `http://127.0.0.1:${started.port}`;
  handle = started;
  return started;
}

afterEach(async () => {
  await handle?.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor timed out');
}

// An explicit token bypasses useTestAuth's default operator token.
function post(path: string, body: unknown, token?: string) {
  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  };
  return token === undefined
    ? fetch(`${baseUrl}${path}`, init)
    : rawFetch(`${baseUrl}${path}`, init);
}

// A milestone with one task per assignee, each with its own write-set.
function milestone(assignees: Record<string, string>) {
  const epicId = store.create({ title: 'Milestone', kind: 'milestone' }).meta
    .id;
  const ids: Record<string, string> = {};
  for (const [name, assignee] of Object.entries(assignees)) {
    ids[name] = store.create({
      title: name,
      kind: 'task',
      parent: epicId,
      assignee,
      writes: [`${name}.ts`],
    }).meta.id;
  }
  return { epicId, ids };
}

async function dispatchedTaskIds(epicId: string): Promise<Set<string>> {
  const progress = await json(
    await fetch(`${baseUrl}/api/epics/${epicId}/progress`)
  );
  return new Set(
    (progress.liveRuns as { taskId: string }[]).map((r) => r.taskId)
  );
}

// Whom GET /api/runs says each run is for (the Cockpit's "me" lane reads it).
async function runOwners(): Promise<Set<string | undefined>> {
  const runs = (await json(await fetch(`${baseUrl}/api/runs`))) as {
    dispatchedBy?: string;
  }[];
  return new Set(runs.map((r) => r.dispatchedBy));
}

describe('POST /api/epics/:id/dispatch and teammates', () => {
  it('leaves a teammate’s unstarted issue alone on a single-user daemon', async () => {
    const { epicId, ids } = milestone({
      unassigned: 'none',
      mine: 'human:test',
      samTask: 'human:sam',
    });
    await boot();
    const me = (await json(await fetch(`${baseUrl}/api/people`))).me;
    expect(me).toBe('human:test');

    const res = await post(`/api/epics/${epicId}/dispatch`, {
      executor: 'fake',
      concurrency: 4,
    });
    expect(res.status).toBe(201);
    expect((await json(res)).startedBy).toBe(me);

    await waitFor(async () => (await dispatchedTaskIds(epicId)).size === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await dispatchedTaskIds(epicId)).toEqual(
      new Set([ids.unassigned, ids.mine])
    );
    expect(await runOwners()).toEqual(new Set([me]));
    const samTask = await json(
      await fetch(`${baseUrl}/api/tasks/${ids.samTask}`)
    );
    expect(samTask.meta.status).toBe('ready');
  });

  it('works for the teammate who started it, never the operator', async () => {
    const { epicId, ids } = milestone({
      unassigned: 'none',
      ada: 'human:ada',
      operator: 'human:test',
      bare: 'human',
    });
    const daemon = await boot();
    daemon.team.license = licensedManager(50);
    const adaToken = daemon.team.teammates.issue('ada', 'request');

    const res = await post(
      `/api/epics/${epicId}/dispatch`,
      { executor: 'fake', concurrency: 4 },
      adaToken
    );
    expect(res.status).toBe(201);
    expect((await json(res)).startedBy).toBe('human:ada');

    await waitFor(async () => (await dispatchedTaskIds(epicId)).size === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await dispatchedTaskIds(epicId)).toEqual(
      new Set([ids.unassigned, ids.ada])
    );
    // Her fan-out's runs are hers, not the operator's.
    expect(await runOwners()).toEqual(new Set(['human:ada']));
  });

  it('tells a teammate’s window whom a bare human assignee means', async () => {
    const daemon = await boot();
    daemon.team.license = licensedManager(50);
    const adaToken = daemon.team.teammates.issue('ada', 'request');
    const res = await rawFetch(`${baseUrl}/api/people`, {
      headers: { authorization: `Bearer ${adaToken}` },
    });
    // Her window is Ada; the fan-out's bare `human` is the daemon's operator.
    expect(await json(res)).toMatchObject({
      me: 'human:ada',
      local: 'human:test',
    });
  });

  it('never takes the starter from the request body', async () => {
    const { epicId, ids } = milestone({ samTask: 'human:sam' });
    await boot();
    const res = await post(`/api/epics/${epicId}/dispatch`, {
      executor: 'fake',
      startedBy: 'human:sam',
    });
    expect((await json(res)).startedBy).toBe('human:test');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await dispatchedTaskIds(epicId)).has(ids.samTask)).toBe(false);
  });
});
