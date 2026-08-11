import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { epicBranchName } from '../../src/orchestrator/epicBranch.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { MergeQueue } from '../../src/orchestrator/mergeQueue.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import type { CommandRunner } from '../../src/orchestrator/pr.js';
import { defaultCommandRunner } from '../../src/orchestrator/pr.js';
import { OrchestratorConflictError } from '../../src/orchestrator/types.js';
import { initGitRepo, runGitSync } from './helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

// Every queue a test builds, so afterEach can stop its retry timers — same
// convention merge-queue.test.ts uses.
const liveQueues: MergeQueue[] = [];

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-epic-branch-');
});

afterEach(() => {
  for (const queue of liveQueues.splice(0)) queue.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

function makeHarness() {
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
    new FakeExecutor({ finish: { state: 'finished' } })
  );
  return { rootDir: repo, store, cache, events, orchestrator };
}

type Harness = ReturnType<typeof makeHarness>;

// A machine with no jj on PATH, so the queue's plain-git restack path runs —
// same stub merge-queue.test.ts uses.
const noJjRunner: CommandRunner = async (cwd, cmd) =>
  cmd[0] === 'jj'
    ? { ok: false, stdout: '', stderr: 'jj: command not found' }
    : defaultCommandRunner(cwd, cmd);

function makeEpicWithChild(
  h: Harness,
  childTitle = 'Child task'
): { epicId: string; taskId: string } {
  const epic = h.store.create({ title: 'The epic', kind: 'epic' });
  const child = h.store.create({ title: childTitle, parent: epic.meta.id });
  h.cache.rebuild(h.store);
  return { epicId: epic.meta.id, taskId: child.meta.id };
}

// Dispatches `taskId`, waits for the fake run to finish, and commits one real
// file on its branch so merges have content to land.
async function dispatchWithWork(
  h: Harness,
  taskId: string,
  file: string,
  content = file
): Promise<string> {
  const meta = await h.orchestrator.dispatch(taskId, 'fake');
  await waitFor(
    () => h.orchestrator.getRun(meta.id)?.meta.state === 'finished'
  );
  const run = h.orchestrator.list().find((r) => r.id === meta.id)!;
  writeFileSync(join(run.worktreePath, file), `${content}\n`);
  runGitSync(run.worktreePath, ['add', '-A']);
  runGitSync(run.worktreePath, ['commit', '-m', `add ${file}`]);
  return meta.id;
}

function fileOnBranch(branch: string, file: string): string | null {
  const result = Bun.spawnSync(['git', 'show', `${branch}:${file}`], {
    cwd: repo,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.exitCode === 0 ? result.stdout.toString('utf8') : null;
}

describe('epic branch creation at dispatch', () => {
  it('lazily cuts epic/<id> from the default base on first dispatch and uses it as baseBranch', async () => {
    const h = makeHarness();
    const { epicId, taskId } = makeEpicWithChild(h);
    const branch = epicBranchName(epicId);
    expect(runGitSync(repo, ['branch', '--list', branch]).trim()).toBe('');

    const run = await h.orchestrator.dispatch(taskId, 'fake');

    expect(run.baseBranch).toBe(branch);
    // Cut from main's tip.
    expect(runGitSync(repo, ['rev-parse', branch]).trim()).toBe(
      runGitSync(repo, ['rev-parse', 'main']).trim()
    );
    // The creation is recorded on the epic's own Activity.
    expect(h.store.get(epicId)?.body).toContain(
      `integration branch ${branch} created from main`
    );
  });

  it('reuses the existing epic branch for later dispatches instead of re-creating it', async () => {
    const h = makeHarness();
    const { epicId, taskId } = makeEpicWithChild(h);
    const sibling = h.store.create({
      title: 'Second child',
      parent: epicId,
    });
    h.cache.rebuild(h.store);
    const branch = epicBranchName(epicId);

    await dispatchWithWork(h, taskId, 'a.txt');
    const tip = runGitSync(repo, ['rev-parse', branch]).trim();
    const second = await h.orchestrator.dispatch(sibling.meta.id, 'fake');

    expect(second.baseBranch).toBe(branch);
    // Still pointing where it was — dispatch never moved or re-cut it.
    expect(runGitSync(repo, ['rev-parse', branch]).trim()).toBe(tip);
    const activity = h.store.get(epicId)?.body ?? '';
    expect(activity.split('integration branch').length).toBe(2);
  });

  it('leaves tasks without a parent epic on the default base', async () => {
    const h = makeHarness();
    const task = h.store.create({ title: 'Plain task' });
    h.cache.rebuild(h.store);
    const run = await h.orchestrator.dispatch(task.meta.id, 'fake');
    expect(run.baseBranch).toBe('main');
  });
});

describe('review-merge onto the epic branch', () => {
  it('lands the run on epic/<id> without touching main or the main checkout', async () => {
    const h = makeHarness();
    const { epicId, taskId } = makeEpicWithChild(h);
    const branch = epicBranchName(epicId);
    const runId = await dispatchWithWork(h, taskId, 'a.txt', 'A work');
    const mainTipBefore = runGitSync(repo, ['rev-parse', 'main']).trim();

    const reviewed = h.orchestrator.review(runId, 'merge');

    expect(reviewed.reviewAction).toBe('merge');
    expect(reviewed.mergeCommit).toBeDefined();
    // The squash commit is the epic branch's new tip, and carries the file.
    expect(reviewed.mergeCommit).toBe(
      runGitSync(repo, ['rev-parse', branch]).trim()
    );
    expect(fileOnBranch(branch, 'a.txt')).toBe('A work\n');
    // Main did not move, is still checked out, and never saw the file.
    expect(runGitSync(repo, ['rev-parse', 'main']).trim()).toBe(mainTipBefore);
    expect(runGitSync(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      'main'
    );
    expect(fileOnBranch('main', 'a.txt')).toBeNull();
    // Task closed, run's branch/worktree cleaned up.
    expect(h.store.get(taskId)?.meta.status).toBe('done');
    const runBranch = h.orchestrator.list().find((r) => r.id === runId)!.branch;
    expect(runGitSync(repo, ['branch', '--list', runBranch]).trim()).toBe('');
  });

  it('merges a second child cleanly after the epic branch moved under it', async () => {
    const h = makeHarness();
    const { epicId, taskId } = makeEpicWithChild(h, 'Child A');
    const branch = epicBranchName(epicId);
    const taskB = h.store.create({ title: 'Child B', parent: epicId });
    h.cache.rebuild(h.store);

    const runA = await dispatchWithWork(h, taskId, 'a.txt', 'A work');
    const runB = await dispatchWithWork(h, taskB.meta.id, 'b.txt', 'B work');
    // A lands first, moving the epic tip past what B was cut from.
    h.orchestrator.review(runA, 'merge');
    const reviewedB = h.orchestrator.review(runB, 'merge');

    expect(reviewedB.reviewAction).toBe('merge');
    expect(fileOnBranch(branch, 'a.txt')).toBe('A work\n');
    expect(fileOnBranch(branch, 'b.txt')).toBe('B work\n');
  });

  it('409s a real content conflict and leaves the epic branch tip unmoved', async () => {
    const h = makeHarness();
    const { epicId, taskId } = makeEpicWithChild(h, 'Child A');
    const branch = epicBranchName(epicId);
    const taskB = h.store.create({ title: 'Child B', parent: epicId });
    h.cache.rebuild(h.store);

    const runA = await dispatchWithWork(h, taskId, 'same.txt', 'A version');
    const runB = await dispatchWithWork(
      h,
      taskB.meta.id,
      'same.txt',
      'B version'
    );
    h.orchestrator.review(runA, 'merge');
    const tip = runGitSync(repo, ['rev-parse', branch]).trim();

    expect(() => h.orchestrator.review(runB, 'merge')).toThrow(
      OrchestratorConflictError
    );
    expect(runGitSync(repo, ['rev-parse', branch]).trim()).toBe(tip);
    // The run stays unreviewed, so a human can resolve and retry.
    const metaB = h.orchestrator.list().find((r) => r.id === runB)!;
    expect(metaB.reviewedAt).toBeUndefined();
  });

  it('409s with a named reason when the epic branch was deleted by hand', async () => {
    const h = makeHarness();
    const { epicId, taskId } = makeEpicWithChild(h);
    const branch = epicBranchName(epicId);
    const runId = await dispatchWithWork(h, taskId, 'a.txt');
    runGitSync(repo, ['branch', '-D', branch]);

    expect(() => h.orchestrator.review(runId, 'merge')).toThrow(
      `epic branch ${branch} no longer exists`
    );
    const meta = h.orchestrator.list().find((r) => r.id === runId)!;
    expect(meta.reviewedAt).toBeUndefined();
  });

  it('falls back to the checkout merge path when the epic branch is checked out in the main repo', async () => {
    const h = makeHarness();
    const { epicId, taskId } = makeEpicWithChild(h);
    const branch = epicBranchName(epicId);
    const runId = await dispatchWithWork(h, taskId, 'a.txt', 'A work');
    runGitSync(repo, ['checkout', branch]);

    const reviewed = h.orchestrator.review(runId, 'merge');

    expect(reviewed.reviewAction).toBe('merge');
    expect(fileOnBranch(branch, 'a.txt')).toBe('A work\n');
    // The checkout path merged into the working tree, which must still be on
    // the epic branch and clean afterwards — untracked `.dispatch/`
    // bookkeeping excepted, exactly as the merge gates themselves except it.
    expect(runGitSync(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      branch
    );
    const dirt = runGitSync(repo, ['status', '--porcelain'])
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.includes('.dispatch/'));
    expect(dirt).toEqual([]);
  });

  it('reconciles a hand merge of a child branch into the epic branch', async () => {
    const h = makeHarness();
    const { epicId, taskId } = makeEpicWithChild(h);
    const branch = epicBranchName(epicId);
    const runId = await dispatchWithWork(h, taskId, 'a.txt');
    const runBranch = h.orchestrator.list().find((r) => r.id === runId)!.branch;

    // A hand squash-merge into the epic branch, done in a scratch worktree the
    // way a user would (the epic branch is not checked out in the main repo).
    runGitSync(repo, ['checkout', branch]);
    runGitSync(repo, ['merge', '--squash', runBranch]);
    runGitSync(repo, ['commit', '-m', 'hand merge']);
    runGitSync(repo, ['checkout', 'main']);

    const reconciled = h.orchestrator.reconcileExternallyMergedRuns();
    expect(reconciled.map((r) => r.id)).toContain(runId);
    expect(h.store.get(taskId)?.meta.status).toBe('done');
  });
});

describe('epic branches on the branches surface', () => {
  it('lists the epic branch with status epic and surfaces drift behind the default base', async () => {
    const h = makeHarness();
    const { epicId, taskId } = makeEpicWithChild(h);
    const branch = epicBranchName(epicId);
    await dispatchWithWork(h, taskId, 'a.txt');

    // Main moves on after the epic branch was cut — that is drift, which is
    // surfaced rather than repaired.
    writeFileSync(join(repo, 'mainline.txt'), 'mainline\n');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'mainline work']);

    const entry = h.orchestrator
      .listBranches()
      .find((e) => e.branch === branch);
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('epic');
    expect(entry?.baseBranch).toBe('main');
    expect(entry?.behindBase).toBe(1);
    // Nothing has merged into it yet, so nothing is ahead either.
    expect(entry?.ahead).toBe(0);
  });

  it('refuses to delete an epic branch that unreviewed child runs are based on', async () => {
    const h = makeHarness();
    const { epicId, taskId } = makeEpicWithChild(h);
    const branch = epicBranchName(epicId);
    await dispatchWithWork(h, taskId, 'a.txt');

    expect(() => h.orchestrator.deleteBranch(branch, { force: true })).toThrow(
      /is the base of/
    );
  });
});

describe('epic branch and the merge queue', () => {
  it('restacks a dependent sibling onto the epic branch after its blocker lands there', async () => {
    const h = makeHarness();
    const { epicId, taskId: taskA } = makeEpicWithChild(h, 'Child A');
    const branch = epicBranchName(epicId);
    const runA = await dispatchWithWork(h, taskA, 'a.txt', 'A work');

    // B is blocked on A, which is in-review — so B stacks on A's branch.
    const taskB = h.store.create({
      title: 'Child B',
      parent: epicId,
      blockedBy: [taskA],
    });
    h.cache.rebuild(h.store);
    const runB = await dispatchWithWork(h, taskB.meta.id, 'b.txt', 'B work');
    const metaA = h.orchestrator.list().find((r) => r.id === runA)!;
    const metaBBefore = h.orchestrator.list().find((r) => r.id === runB)!;
    expect(metaBBefore.baseBranch).toBe(metaA.branch);

    const queue = new MergeQueue(h, noJjRunner);
    liveQueues.push(queue);
    queue.enqueue(runA);
    await waitFor(() =>
      queue.snapshot().history.some((e) => e.state === 'merged')
    );

    // A landed on the epic branch, and B was restacked onto it: the epic
    // branch moved under B, and B followed.
    expect(fileOnBranch(branch, 'a.txt')).toBe('A work\n');
    const metaB = h.orchestrator.list().find((r) => r.id === runB)!;
    expect(metaB.baseDiscarded).toBeUndefined();
    expect(metaB.baseBranch).toBe(branch);
    expect(await Bun.file(join(metaB.worktreePath, 'a.txt')).exists()).toBe(
      true
    );
    expect(await Bun.file(join(metaB.worktreePath, 'b.txt')).exists()).toBe(
      true
    );
  });

  it('flags (mirroring baseDiscarded) a dependent whose blocker landed off its epic branch', async () => {
    const h = makeHarness();
    // The epic branch exists because child C dispatched first.
    const { epicId, taskId: taskC } = makeEpicWithChild(h, 'Child C');
    const branch = epicBranchName(epicId);
    await dispatchWithWork(h, taskC, 'c.txt');

    // A is a plain task outside the epic: its run lands on main.
    const taskA = h.store.create({ title: 'Outside blocker' });
    h.cache.rebuild(h.store);
    const runA = await dispatchWithWork(h, taskA.meta.id, 'a.txt');

    // B lives under the epic but stacks on A's branch.
    const taskB = h.store.create({
      title: 'Child B',
      parent: epicId,
      blockedBy: [taskA.meta.id],
    });
    h.cache.rebuild(h.store);
    const runB = await dispatchWithWork(h, taskB.meta.id, 'b.txt');

    const queue = new MergeQueue(h, noJjRunner);
    liveQueues.push(queue);
    queue.enqueue(runA);
    await waitFor(() =>
      queue.snapshot().history.some((e) => e.state === 'merged')
    );
    await waitFor(
      () =>
        h.orchestrator.list().find((r) => r.id === runB)?.baseDiscarded === true
    );

    const metaB = h.orchestrator.list().find((r) => r.id === runB)!;
    expect(metaB.baseDiscarded).toBe(true);
    expect(metaB.baseDiscardedReason).toContain(branch);
    expect(metaB.baseDiscardedReason).toContain('landed on main');
    // Nothing was rewritten: B still sits on A's branch, untouched.
    expect(metaB.baseBranch).toBe(
      h.orchestrator.list().find((r) => r.id === runA)!.branch
    );
  });
});
