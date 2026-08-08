import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { runsDir, worktreesDir } from '../../src/orchestrator/paths.js';
import { WorktreeManager } from '../../src/orchestrator/worktree.js';
import { initGitRepo, runGitSync } from './helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-aux-cleanup-');
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

function makeOrchestrator(): { orchestrator: Orchestrator; store: TaskStore } {
  const store = TaskStore.init(repo);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const orchestrator = new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events,
  });
  orchestrator.registerExecutor(
    'fake',
    new FakeExecutor({
      steps: [{ approval: { requestId: 'go', toolName: 'noop', input: {} } }],
      finish: { state: 'finished', costUsd: 0, turns: 1 },
    })
  );
  return { orchestrator, store };
}

// A second Orchestrator over the same repo and store — a restarted daemon,
// whose registry and ReviewRunner.pending both start empty.
function rebootOrchestrator(store: TaskStore): Orchestrator {
  const cache = new TaskCache();
  cache.rebuild(store);
  return new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events: new EventBus(),
  });
}

// A verify run parked at its approval gate, with the kind of edit a verify
// agent leaves behind after getting the app to build.
async function auxRunWithEdit(
  orchestrator: Orchestrator,
  store: TaskStore
): Promise<{ runId: string; branch: string; worktreePath: string }> {
  const task = store.create({ title: 'exercise the app' });
  const meta = await orchestrator.dispatchAuxRun({
    taskId: task.meta.id,
    kind: 'verify',
    executor: 'fake',
    head: 'main',
    buildPrompt: () => 'go verify',
  });
  await waitFor(
    () => orchestrator.getRun(meta.id)?.meta.state === 'awaiting-approval'
  );
  writeFileSync(join(meta.worktreePath, 'fix.ts'), 'export const fixed = 1;\n');
  return {
    runId: meta.id,
    branch: meta.branch,
    worktreePath: meta.worktreePath,
  };
}

describe('aux run cleanup keeps work that was never merged', () => {
  it('keeps the branch of a cancelled verify run that has uncommitted edits', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const aux = await auxRunWithEdit(orchestrator, store);

    await orchestrator.cancel(aux.runId);
    orchestrator.cleanupAuxRun(aux.runId);

    expect(existsSync(aux.worktreePath)).toBe(false);
    const branches = runGitSync(repo, ['branch', '--list', aux.branch]);
    expect(branches.trim()).not.toBe('');
    const files = runGitSync(repo, [
      'show',
      '--name-only',
      '--format=',
      aux.branch,
    ]);
    expect(files).toContain('fix.ts');
  });

  it('still deletes the branch of an aux run that changed nothing', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const task = store.create({ title: 'clean verify' });
    const meta = await orchestrator.dispatchAuxRun({
      taskId: task.meta.id,
      kind: 'verify',
      executor: 'fake',
      head: 'main',
      buildPrompt: () => 'go verify',
    });
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'awaiting-approval'
    );

    await orchestrator.cancel(meta.id);
    orchestrator.cleanupAuxRun(meta.id);

    expect(existsSync(meta.worktreePath)).toBe(false);
    expect(runGitSync(repo, ['branch', '--list', meta.branch]).trim()).toBe('');
  });
});

// The counterpart to the two above: a review of someone else's artifact has
// no output that belongs on a branch, and its anchor task has no life after
// the review. Both are read off the task's `derivedFrom`.
// A review run parked at its approval gate, against a task synthesized from
// a PR — the shape POST /api/prs/:number/review-agent produces.
async function derivedReviewRun(orchestrator: Orchestrator, store: TaskStore) {
  const task = store.create({
    title: 'Review PR #7: Bump deps',
    derivedFrom: 'github-pr:7',
  });
  const meta = await orchestrator.dispatchAuxRun({
    taskId: task.meta.id,
    kind: 'review',
    executor: 'fake',
    head: 'main',
    buildPrompt: () => 'go review',
  });
  await waitFor(
    () => orchestrator.getRun(meta.id)?.meta.state === 'awaiting-approval'
  );
  return { task, meta };
}

describe('aux run cleanup on a derived task', () => {
  it('discards the branch even when the review agent left files behind', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const { meta } = await derivedReviewRun(orchestrator, store);
    // The very edit that makes a verify run's branch worth keeping. A review
    // of a fork's head must not turn it into a permanent local branch
    // carrying that fork's code.
    writeFileSync(join(meta.worktreePath, 'stray.ts'), 'export const x = 1;\n');

    await orchestrator.cancel(meta.id);
    orchestrator.cleanupAuxRun(meta.id);

    expect(existsSync(meta.worktreePath)).toBe(false);
    expect(runGitSync(repo, ['branch', '--list', meta.branch]).trim()).toBe('');
  });

  it('retires the derived task once its review run is cleaned up', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const { task, meta } = await derivedReviewRun(orchestrator, store);
    expect(store.get(task.meta.id)!.meta.status).toBe('todo');

    await orchestrator.cancel(meta.id);
    orchestrator.cleanupAuxRun(meta.id);

    // Done and archived: the board must not keep a permanently outstanding
    // PR-derived row, and both syncers skip an archived doc.
    const retired = store.get(task.meta.id)!;
    expect(retired.meta.status).toBe('done');
    expect(retired.meta.archivedAt).not.toBeUndefined();
  });

  it('leaves an authored task alone when its aux run is cleaned up', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const aux = await auxRunWithEdit(orchestrator, store);
    const taskId = orchestrator.getRun(aux.runId)!.meta.taskId;

    await orchestrator.cancel(aux.runId);
    orchestrator.cleanupAuxRun(aux.runId);

    const after = store.get(taskId)!;
    expect(after.meta.status).not.toBe('done');
    expect(after.meta.archivedAt).toBeUndefined();
  });
});

// ReviewRunner.pending is in-memory, so a daemon that restarts mid-review has
// nobody left listening when the run goes terminal. Boot reconciliation has to
// retire the derived task itself, off the task's durable `derivedFrom`.
describe('a restarted daemon retires the review it lost', () => {
  it('retires a review run the crash left running', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const { task, meta } = await derivedReviewRun(orchestrator, store);

    const second = rebootOrchestrator(store);
    second.reconcileOnBoot();

    const retired = store.get(task.meta.id)!;
    expect(retired.meta.status).toBe('done');
    expect(retired.meta.archivedAt).not.toBeUndefined();
    expect(existsSync(meta.worktreePath)).toBe(false);
    expect(runGitSync(repo, ['branch', '--list', meta.branch]).trim()).toBe('');
  });

  it('retires a review run that was already terminal on disk', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const { task, meta } = await derivedReviewRun(orchestrator, store);
    // Terminal before the restart, with no cleanup: the crash landed between
    // the run finishing and its ingest.
    await orchestrator.cancel(meta.id);
    expect(store.get(task.meta.id)!.meta.status).not.toBe('done');

    const second = rebootOrchestrator(store);
    second.reconcileOnBoot();

    const retired = store.get(task.meta.id)!;
    expect(retired.meta.status).toBe('done');
    expect(retired.meta.archivedAt).not.toBeUndefined();
    expect(existsSync(meta.worktreePath)).toBe(false);
  });

  it('leaves a review it already retired alone on the next boot', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const { task, meta } = await derivedReviewRun(orchestrator, store);
    await orchestrator.cancel(meta.id);
    orchestrator.cleanupAuxRun(meta.id);
    const once = store.get(task.meta.id)!;
    expect(once.meta.archivedAt).not.toBeUndefined();

    rebootOrchestrator(store).reconcileOnBoot();

    const twice = store.get(task.meta.id)!;
    expect(twice.meta.archivedAt).toBe(once.meta.archivedAt);
    expect(twice.body).toBe(once.body);
  });

  it('keeps an authored aux run’s branch across a restart', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const aux = await auxRunWithEdit(orchestrator, store);
    const taskId = orchestrator.getRun(aux.runId)!.meta.taskId;

    rebootOrchestrator(store).reconcileOnBoot();

    // Phase 4's deliberate arrangement: unmerged work survives a reboot, and
    // the human's own task is never retired out from under them.
    expect(runGitSync(repo, ['branch', '--list', aux.branch]).trim()).not.toBe(
      ''
    );
    expect(store.get(taskId)!.meta.status).not.toBe('done');
  });
});

describe('the boot-time orphan sweep refuses to act on an empty keep-set', () => {
  it('keeps every worktree when no transcript could be enumerated', () => {
    const { orchestrator } = makeOrchestrator();
    const worktrees = new WorktreeManager(repo);
    mkdirSync(worktreesDir(repo), { recursive: true });
    const kept = join(worktreesDir(repo), 'r-keepme');
    worktrees.add(kept, 'dispatch/keepme', 'main');

    // The exact shape that emptied a real project: the runs directory — every
    // transcript, and so the whole keep-set — is moved aside.
    rmSync(runsDir(repo), { recursive: true, force: true });
    orchestrator.reconcileOnBoot();

    expect(existsSync(kept)).toBe(true);
  });

  it('still prunes an orphan when the keep-set has entries', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const task = store.create({ title: 'real run' });
    const live = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(live.id)?.meta.state === 'awaiting-approval'
    );
    await orchestrator.cancel(live.id);

    const worktrees = new WorktreeManager(repo);
    const orphan = join(worktreesDir(repo), 'r-orphan');
    worktrees.add(orphan, 'dispatch/orphan', 'main');

    orchestrator.reconcileOnBoot();

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(live.worktreePath)).toBe(true);
  });
});
