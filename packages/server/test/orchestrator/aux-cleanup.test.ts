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
import type {
  CommandResult,
  CommandRunner,
} from '../../src/orchestrator/pr.js';
import { defaultCommandRunner } from '../../src/orchestrator/pr.js';
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

// Records every argv the orchestrator hands to git and answers with one
// canned result — the same CommandRunner seam PrManager and MergeQueue take.
function recordingRunner(
  result: CommandResult = { ok: true, stdout: '', stderr: '' }
): { calls: string[][]; run: CommandRunner } {
  const calls: string[][] = [];
  return {
    calls,
    run: (_cwd, cmd) => {
      calls.push(cmd);
      return Promise.resolve(result);
    },
  };
}

// Both factories below default to a stub rather than the real runner, so a
// test that is not about the ref delete never leaves a `git update-ref` still
// running against a repo afterEach has already deleted. The one test that
// wants real git passes `defaultCommandRunner` itself.
function makeOrchestrator(
  commandRunner: CommandRunner = recordingRunner().run
): {
  orchestrator: Orchestrator;
  store: TaskStore;
} {
  const store = TaskStore.init(repo);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const orchestrator = new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events,
    commandRunner,
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
function rebootOrchestrator(
  store: TaskStore,
  commandRunner: CommandRunner = recordingRunner().run
): Orchestrator {
  const cache = new TaskCache();
  cache.rebuild(store);
  return new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events: new EventBus(),
    commandRunner,
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
async function derivedReviewRun(
  orchestrator: Orchestrator,
  store: TaskStore,
  number = 7
) {
  const task = store.create({
    title: `Review PR #${number}: Bump deps`,
    derivedFrom: `github-pr:${number}`,
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
    expect(store.get(task.meta.id)!.meta.status).toBe('ready');

    await orchestrator.cancel(meta.id);
    orchestrator.cleanupAuxRun(meta.id);

    // Done and archived: the board must not keep a permanently outstanding
    // PR-derived row, and both syncers skip an archived doc.
    const retired = store.get(task.meta.id)!;
    expect(retired.meta.status).toBe('landed');
    expect(retired.meta.archivedAt).not.toBeUndefined();
  });

  it('leaves an authored task alone when its aux run is cleaned up', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const aux = await auxRunWithEdit(orchestrator, store);
    const taskId = orchestrator.getRun(aux.runId)!.meta.taskId;

    await orchestrator.cancel(aux.runId);
    orchestrator.cleanupAuxRun(aux.runId);

    const after = store.get(taskId)!;
    expect(after.meta.status).not.toBe('landed');
    expect(after.meta.archivedAt).toBeUndefined();
  });
});

// Every `refs/dispatch/pr/*` this repo currently holds.
function prHeadRefs(): string[] {
  return runGitSync(repo, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/dispatch/pr/',
  ])
    .split('\n')
    .filter((line) => line !== '');
}

// fetchPrHead parks a PR's head at `refs/dispatch/pr/<n>` and nothing used to
// remove it, so every review left one behind forever — each a standing
// start-point for a worktree cut without passing the fork gate.
describe('a retiring PR review takes its head ref with it', () => {
  // Real git, not a stub: the point of this one is that the argv actually
  // removes the ref, not merely that something was run.
  it('deletes the ref the review was cut from', async () => {
    const { orchestrator, store } = makeOrchestrator(defaultCommandRunner);
    const { meta } = await derivedReviewRun(orchestrator, store);
    runGitSync(repo, ['update-ref', 'refs/dispatch/pr/7', 'main']);
    expect(prHeadRefs()).toEqual(['refs/dispatch/pr/7']);

    await orchestrator.cancel(meta.id);
    orchestrator.cleanupAuxRun(meta.id);
    await orchestrator.prRefDeleteSettled(meta.id);

    expect(prHeadRefs()).toEqual([]);
  });

  it('retires the task anyway when the delete fails', async () => {
    const { calls, run } = recordingRunner({
      ok: false,
      stdout: '',
      stderr: 'update-ref exploded',
    });
    const { orchestrator, store } = makeOrchestrator(run);
    const { task, meta } = await derivedReviewRun(orchestrator, store);
    runGitSync(repo, ['update-ref', 'refs/dispatch/pr/7', 'main']);

    await orchestrator.cancel(meta.id);
    orchestrator.cleanupAuxRun(meta.id);
    await orchestrator.prRefDeleteSettled(meta.id);

    const retired = store.get(task.meta.id)!;
    expect(retired.meta.status).toBe('landed');
    expect(retired.meta.archivedAt).not.toBeUndefined();
    // Non-vacuous: the delete really was attempted, and really did fail.
    expect(calls).toEqual([['git', 'update-ref', '-d', 'refs/dispatch/pr/7']]);
    expect(prHeadRefs()).toEqual(['refs/dispatch/pr/7']);
  });

  it('deletes the ref of a review boot had to retire', async () => {
    const { orchestrator, store } = makeOrchestrator();
    await derivedReviewRun(orchestrator, store);
    runGitSync(repo, ['update-ref', 'refs/dispatch/pr/7', 'main']);

    const { calls, run } = recordingRunner();
    const second = rebootOrchestrator(store, run);
    second.reconcileOnBoot();
    await Promise.all(
      second.list().map((meta) => second.prRefDeleteSettled(meta.id))
    );

    expect(calls).toEqual([['git', 'update-ref', '-d', 'refs/dispatch/pr/7']]);
  });

  // A `derivedFrom` that is not a PR review origin names no ref at all —
  // guessing one from it is how an unrelated ref gets deleted.
  it('deletes nothing for a derived task that is not a PR review', async () => {
    const { calls, run } = recordingRunner();
    const { orchestrator, store } = makeOrchestrator(run);
    const task = store.create({
      title: 'Review ENG-4',
      derivedFrom: 'linear-issue:ENG-4',
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

    await orchestrator.cancel(meta.id);
    orchestrator.cleanupAuxRun(meta.id);
    await orchestrator.prRefDeleteSettled(meta.id);

    expect(store.get(task.meta.id)!.meta.status).toBe('landed');
    expect(calls).toEqual([]);
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
    expect(retired.meta.status).toBe('landed');
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
    expect(store.get(task.meta.id)!.meta.status).not.toBe('landed');

    const second = rebootOrchestrator(store);
    second.reconcileOnBoot();

    const retired = store.get(task.meta.id)!;
    expect(retired.meta.status).toBe('landed');
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

  // Boot retires the task but never ingests the review's findings — and
  // findings.json outlives the worktree. A note that reads like a completed
  // review would present unread output as "reviewed, nothing found".
  it('says a boot-retired review never had its findings ingested', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const { task } = await derivedReviewRun(orchestrator, store);

    rebootOrchestrator(store).reconcileOnBoot();

    expect(store.get(task.meta.id)!.body).toContain('never ingested');
  });

  it('says no such thing when the review was retired normally', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const { task, meta } = await derivedReviewRun(orchestrator, store);

    await orchestrator.cancel(meta.id);
    orchestrator.cleanupAuxRun(meta.id);

    expect(store.get(task.meta.id)!.body).not.toContain('never ingested');
  });

  // The shape a merge-conflicted or half-edited task file takes. One of them
  // must not abort the sweep — nor the archive reconcile and crash surveys
  // that run after it.
  it('keeps sweeping past a task file that no longer parses', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const broken = await derivedReviewRun(orchestrator, store, 7);
    const intact = await derivedReviewRun(orchestrator, store, 8);
    writeFileSync(
      store.taskFilePath(broken.task.meta.id)!,
      'this is not a task file\n'
    );

    const second = rebootOrchestrator(store);
    expect(() => {
      second.reconcileOnBoot();
    }).not.toThrow();

    expect(store.get(intact.task.meta.id)!.meta.status).toBe('landed');
  });

  // The test above never reaches the sweep's error containment: the cache is
  // built from the already-broken file, so the lookup simply misses. Breaking
  // it after the rebuild is what puts a throw *past* the lookup — here from
  // cleanupAuxRun's own store.get, which still parses the file eagerly.
  it('contains a task that breaks after the boot cache was built', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const { task, meta } = await derivedReviewRun(orchestrator, store);

    const second = rebootOrchestrator(store);
    writeFileSync(store.taskFilePath(task.meta.id)!, 'not a task file\n');

    expect(() => {
      second.reconcileOnBoot();
    }).not.toThrow();

    // Non-vacuous, and the two assertions only hold together: the retirement
    // aborted partway (worktree still there), and the throw that aborted it
    // did not escape. Without the containment this test throws TaskParseError.
    expect(existsSync(meta.worktreePath)).toBe(true);
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
    expect(store.get(taskId)!.meta.status).not.toBe('landed');
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
