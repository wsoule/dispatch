import { TaskStore } from '@dispatch/core';
import type { TaskDoc } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakePlanner } from '../src/orchestrator/planners/fake.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// Tasks are filed under containers through `parent`; the legacy free-form
// `milestone` string is only read. These cover what a caller that still sends
// one gets, and the draft path's parent.

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-task-hierarchy-api-'));
  runGitSync(root, ['init', '-b', 'main']);
  runGitSync(root, ['config', 'user.email', 'test@example.com']);
  runGitSync(root, ['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'README.md'), '# test repo\n');
  runGitSync(root, ['add', '-A']);
  runGitSync(root, ['commit', '-m', 'initial commit']);
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerPlanners: (planManager) => {
      planManager.registerPlanner(
        'claude',
        new FakePlanner({ ok: true, proposal: { tasks: [] } })
      );
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

function send(path: string, method: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function create(body: Record<string, unknown>): Promise<TaskDoc> {
  const res = await send('/api/tasks', 'POST', body);
  expect(res.status).toBe(201);
  return (await res.json()) as TaskDoc;
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('waitFor timed out');
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

describe('a legacy milestone on create and update', () => {
  it('files the task under the container it names, and writes no milestone', async () => {
    const project = await create({ title: 'Payments', kind: 'project' });
    const beta = await create({
      title: 'Beta',
      kind: 'milestone',
      parent: project.meta.id,
    });

    const byTitle = await create({ title: 'Charge card', milestone: 'beta' });
    expect(byTitle.meta.parent).toBe(beta.meta.id);
    expect(byTitle.meta.milestone).toBeNull();

    // What older desktop builds sent from a milestone group's "+".
    const byId = await create({ title: 'Refunds', milestone: beta.meta.id });
    expect(byId.meta.parent).toBe(beta.meta.id);

    // The store never sees the key at all.
    const onDisk = new TaskStore(root).get(byTitle.meta.id);
    expect(onDisk?.meta.milestone).toBeNull();
  });

  it('400s a milestone nothing is titled, and writes nothing', async () => {
    const res = await send('/api/tasks', 'POST', {
      title: 'Orphan',
      milestone: 'Gamma',
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe(
      'invalid milestone: no project or milestone is titled "Gamma" — create it first, or send parent'
    );
    expect(new TaskStore(root).list()).toHaveLength(0);
  });

  it('400s a name two containers share, a parent that disagrees, and a non-string', async () => {
    const one = await create({ title: 'Beta', kind: 'milestone' });
    await create({ title: 'Beta', kind: 'project' });
    const ambiguous = await send('/api/tasks', 'POST', {
      title: 'X',
      milestone: 'Beta',
    });
    expect(ambiguous.status).toBe(400);
    expect(await errorOf(ambiguous)).toContain('matches');

    const other = await create({ title: 'Solo', kind: 'milestone' });
    const conflict = await send('/api/tasks', 'POST', {
      title: 'X',
      milestone: 'Solo',
      parent: one.meta.id,
    });
    expect(conflict.status).toBe(400);
    expect(await errorOf(conflict)).toBe(
      `invalid milestone: "Solo" is ${other.meta.id}, but parent is ${one.meta.id} — send parent only`
    );

    const agreeing = await create({
      title: 'Y',
      milestone: 'Solo',
      parent: other.meta.id,
    });
    expect(agreeing.meta.parent).toBe(other.meta.id);

    const typed = await send('/api/tasks', 'POST', {
      title: 'Z',
      milestone: 7,
    });
    expect(typed.status).toBe(400);
  });

  it('refuses a container that cannot hold the kind being created', async () => {
    await create({ title: 'Beta', kind: 'milestone' });
    const res = await send('/api/tasks', 'POST', {
      title: 'Big',
      kind: 'project',
      milestone: 'Beta',
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('a project cannot sit under');
  });

  it('ignores a null milestone, the way old clients sent an unset one', async () => {
    const task = await create({
      title: 'Loose',
      milestone: null,
      parent: null,
    });
    expect(task.meta.parent).toBeNull();
    expect(task.meta.milestone).toBeNull();
  });

  it('moves a task on PATCH and keeps an old file’s milestone readable', async () => {
    const beta = await create({ title: 'Beta', kind: 'milestone' });
    // A task written before the hierarchy, still carrying the old string.
    const legacy = new TaskStore(root).create({
      title: 'Old',
      milestone: 'Q3',
    });
    await waitFor(
      async () =>
        (await fetch(`${baseUrl}/api/tasks/${legacy.meta.id}`)).status === 200
    );

    const res = await send(`/api/tasks/${legacy.meta.id}`, 'PATCH', {
      milestone: 'Beta',
    });
    expect(res.status).toBe(200);
    const moved = (await res.json()) as TaskDoc;
    expect(moved.meta.parent).toBe(beta.meta.id);
    expect(moved.meta.milestone).toBe('Q3');

    const unknown = await send(`/api/tasks/${legacy.meta.id}`, 'PATCH', {
      milestone: 'Nope',
    });
    expect(unknown.status).toBe(400);
  });

  it('400s a parent that is not a string or null', async () => {
    const res = await send('/api/tasks', 'POST', { title: 'X', parent: 42 });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe(
      'invalid parent: expected a string or null'
    );
  });
});

describe('a draft started inside a container', () => {
  it('carries the parent on its record', async () => {
    const beta = await create({ title: 'Beta', kind: 'milestone' });
    const res = await send('/api/tasks/draft', 'POST', {
      prompt: 'add refunds',
      parent: beta.meta.id,
    });
    expect(res.status).toBe(202);
    const record = (await res.json()) as { id: string; parent?: string };
    expect(record.parent).toBe(beta.meta.id);
    const listed = (await (
      await fetch(`${baseUrl}/api/tasks/drafts/${record.id}`)
    ).json()) as { parent?: string };
    expect(listed.parent).toBe(beta.meta.id);
  });

  it('leaves the parent off without one, and 400s one that does not exist', async () => {
    const plain = (await (
      await send('/api/tasks/draft', 'POST', { prompt: 'add refunds' })
    ).json()) as Record<string, unknown>;
    expect('parent' in plain).toBe(false);

    const missing = await send('/api/tasks/draft', 'POST', {
      prompt: 'add refunds',
      parent: 'e-000000',
    });
    expect(missing.status).toBe(400);
    expect(await errorOf(missing)).toBe('invalid parent: no task e-000000');
  });
});
