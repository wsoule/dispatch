import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
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
import { transcriptPath } from '../../src/orchestrator/paths.js';
import { replayTranscript } from '../../src/orchestrator/transcript.js';
import { OrchestratorConflictError } from '../../src/orchestrator/types.js';
import { initGitRepo, runGitSync } from './helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-stack-');
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

// The FakeExecutor plays its script fire-and-forget, so a run's terminal
// state lands some ticks after `dispatch()` resolves. Stacking only ever
// considers a blocker's TERMINAL, unreviewed run, so these tests have to
// wait for that to settle before dispatching the dependent.
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
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
  return { store, cache, events, orchestrator };
}

type Harness = ReturnType<typeof makeHarness>;

// Dispatches each named task, lets its run finish, commits a distinct file on
// its branch, and moves it to `in-review` — i.e. leaves it in exactly the
// state that makes it an unmerged blocker worth stacking on.
async function makeInReviewBlockers(
  h: Harness,
  titles: string[],
  // The file each blocker writes its title into. Defaults to one file per
  // blocker; give several the same file to make them conflict.
  fileFor: (title: string) => string = (title) => `${title}.txt`
): Promise<{ ids: string[]; branches: string[] }> {
  const ids: string[] = [];
  const branches: string[] = [];
  for (const title of titles) {
    const task = h.store.create({ title });
    const run = await h.orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => h.orchestrator.getRun(run.id)?.meta.state === 'finished'
    );
    await Bun.write(join(run.worktreePath, fileFor(title)), title);
    runGitSync(run.worktreePath, ['add', '-A']);
    runGitSync(run.worktreePath, ['commit', '-m', `${title} work`]);
    h.store.update(
      task.meta.id,
      { status: 'review' },
      new Date().toISOString()
    );
    ids.push(task.meta.id);
    branches.push(run.branch);
  }
  h.cache.rebuild(h.store);
  return { ids, branches };
}

function activityFor(h: Harness, taskId: string): string {
  return h.store.get(taskId)?.body ?? '';
}

// Builds the single-blocker stacked shape a discard test needs: a finished,
// in-review blocker run with its own commit, and a dependent run branched off
// it (per resolveBase's single-parent path) with its own distinct commit.
// Mirrors the "branches off the blocker branch" test above but returns both
// runs so a caller can review() one and inspect the other.
async function makeStackedPair(h: Harness): Promise<{
  blockerRun: Awaited<ReturnType<typeof h.orchestrator.dispatch>>;
  dependentRun: Awaited<ReturnType<typeof h.orchestrator.dispatch>>;
}> {
  const blocker = h.store.create({ title: 'A' });
  const blockerRun = await h.orchestrator.dispatch(blocker.meta.id, 'fake');
  await waitFor(
    () => h.orchestrator.getRun(blockerRun.id)?.meta.state === 'finished'
  );
  await Bun.write(join(blockerRun.worktreePath, 'a.txt'), 'a');
  runGitSync(blockerRun.worktreePath, ['add', '-A']);
  runGitSync(blockerRun.worktreePath, ['commit', '-m', 'A work']);
  h.store.update(
    blocker.meta.id,
    { status: 'review' },
    new Date().toISOString()
  );
  h.cache.rebuild(h.store);

  const dependent = h.store.create({
    title: 'B',
    blockedBy: [blocker.meta.id],
  });
  h.cache.rebuild(h.store);
  const dependentRun = await h.orchestrator.dispatch(dependent.meta.id, 'fake');
  await waitFor(
    () => h.orchestrator.getRun(dependentRun.id)?.meta.state === 'finished'
  );
  await Bun.write(join(dependentRun.worktreePath, 'b.txt'), 'b');
  runGitSync(dependentRun.worktreePath, ['add', '-A']);
  runGitSync(dependentRun.worktreePath, ['commit', '-m', 'B work']);

  return { blockerRun, dependentRun };
}

// The set of paths git reports as pending in a checkout, ignoring the status
// letters — see its call site for why the letters are deliberately not
// compared.
function statusPaths(dir: string): string[] {
  // `-uall` so an untracked directory is always expanded to its files, and
  // two listings compare equal path by path.
  return runGitSync(dir, ['status', '--porcelain', '-uall'])
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((p) => p.length > 0)
    .sort();
}

describe('base selection', () => {
  it('uses the default base branch when a task has no blockers', async () => {
    const h = makeHarness();
    const task = h.store.create({ title: 'solo' });
    h.cache.rebuild(h.store);

    const meta = await h.orchestrator.dispatch(task.meta.id, 'fake');
    expect(meta.baseBranch).toBe('main');
    expect(meta.stackParents ?? []).toEqual([]);
    expect(meta.stackBaseCommit).toBeUndefined();
  });

  it('branches off the blocker branch when one blocker is in-review', async () => {
    const h = makeHarness();
    const blocker = h.store.create({ title: 'A' });
    const blockerRun = await h.orchestrator.dispatch(blocker.meta.id, 'fake');
    await waitFor(
      () => h.orchestrator.getRun(blockerRun.id)?.meta.state === 'finished'
    );
    // Simulate the blocker finishing: commit work, move task to in-review.
    await Bun.write(join(blockerRun.worktreePath, 'a.txt'), 'a');
    runGitSync(blockerRun.worktreePath, ['add', '-A']);
    runGitSync(blockerRun.worktreePath, ['commit', '-m', 'A work']);
    h.store.update(
      blocker.meta.id,
      { status: 'review' },
      new Date().toISOString()
    );
    h.cache.rebuild(h.store);

    const dependent = h.store.create({
      title: 'B',
      blockedBy: [blocker.meta.id],
    });
    h.cache.rebuild(h.store);

    const meta = await h.orchestrator.dispatch(dependent.meta.id, 'fake');
    expect(meta.baseBranch).toBe(blockerRun.branch);
    expect(meta.stackParents).toEqual([blockerRun.branch]);
    // stackBaseCommit pins where this run's OWN commits begin.
    expect(meta.stackBaseCommit).toBe(
      runGitSync(repo, ['rev-parse', '--verify', blockerRun.branch]).trim()
    );
    // The dependent's worktree must actually contain the blocker's work.
    expect(await Bun.file(join(meta.worktreePath, 'a.txt')).text()).toBe('a');
  });

  it('falls back to the default base when the blocker is already done', async () => {
    const h = makeHarness();
    const blocker = h.store.create({ title: 'A', status: 'landed' });
    const dependent = h.store.create({
      title: 'B',
      blockedBy: [blocker.meta.id],
    });
    h.cache.rebuild(h.store);

    const meta = await h.orchestrator.dispatch(dependent.meta.id, 'fake');
    expect(meta.baseBranch).toBe('main');
    expect(meta.stackParents ?? []).toEqual([]);
  });

  it('falls back to the default base when an in-review blocker has no run', async () => {
    const h = makeHarness();
    const blocker = h.store.create({ title: 'A', status: 'review' });
    const dependent = h.store.create({
      title: 'B',
      blockedBy: [blocker.meta.id],
    });
    h.cache.rebuild(h.store);

    const meta = await h.orchestrator.dispatch(dependent.meta.id, 'fake');
    expect(meta.baseBranch).toBe('main');
    expect(meta.stackParents ?? []).toEqual([]);
  });
});

// A Linear team with no review state: review shares the dispatched status, so
// only the blocker's run says whether its work is up for review.
const SHARED_REVIEW_CONFIG = `statuses:
  - { name: Todo, type: unstarted }
  - { name: In Progress, type: started }
  - { name: Done, type: completed }
  - { name: Canceled, type: canceled }
statusRoles:
  ready: Todo
  dispatched: In Progress
  review: In Progress
  landing: null
  landed: Done
  dropped: Canceled
`;

describe('base selection when review shares the dispatched status', () => {
  // A blocker whose first run finished with a commit, left In Progress.
  async function finishedBlocker(h: Harness) {
    writeFileSync(join(repo, '.dispatch', 'config.yml'), SHARED_REVIEW_CONFIG);
    const blocker = h.store.create({ title: 'A', status: 'Todo' });
    const run = await h.orchestrator.dispatch(blocker.meta.id, 'fake');
    await waitFor(
      () => h.orchestrator.getRun(run.id)?.meta.state === 'finished'
    );
    await Bun.write(join(run.worktreePath, 'a.txt'), 'a');
    runGitSync(run.worktreePath, ['add', '-A']);
    runGitSync(run.worktreePath, ['commit', '-m', 'A work']);
    const dependent = h.store.create({
      title: 'B',
      status: 'Todo',
      blockedBy: [blocker.meta.id],
    });
    h.cache.rebuild(h.store);
    return { blocker, run, dependent };
  }

  it('stacks on a blocker whose run has finished', async () => {
    const h = makeHarness();
    const { blocker, run, dependent } = await finishedBlocker(h);
    expect(h.store.get(blocker.meta.id)?.meta.status).toBe('In Progress');

    const meta = await h.orchestrator.dispatch(dependent.meta.id, 'fake');
    expect(meta.baseBranch).toBe(run.branch);
    expect(meta.stackParents).toEqual([run.branch]);
  });

  it('does not stack on a blocker whose run was cancelled', async () => {
    const h = makeHarness();
    h.orchestrator.registerExecutor(
      'slow',
      new FakeExecutor({
        steps: [{ delayMs: 60_000 }],
        finish: { state: 'finished' },
      })
    );
    writeFileSync(join(repo, '.dispatch', 'config.yml'), SHARED_REVIEW_CONFIG);
    const blocker = h.store.create({ title: 'A', status: 'Todo' });
    const run = await h.orchestrator.dispatch(blocker.meta.id, 'slow');
    await Bun.write(join(run.worktreePath, 'a.txt'), 'a');
    runGitSync(run.worktreePath, ['add', '-A']);
    runGitSync(run.worktreePath, ['commit', '-m', 'partial A work']);
    await h.orchestrator.cancel(run.id);
    const dependent = h.store.create({
      title: 'B',
      status: 'Todo',
      blockedBy: [blocker.meta.id],
    });
    h.cache.rebuild(h.store);
    // A cancel leaves the blocker where it was: still In Progress.
    expect(h.store.get(blocker.meta.id)?.meta.status).toBe('In Progress');

    const meta = await h.orchestrator.dispatch(dependent.meta.id, 'fake');
    expect(meta.baseBranch).toBe('main');
    expect(meta.stackParents ?? []).toEqual([]);
  });

  it('does not stack on an earlier branch while the blocker runs again', async () => {
    const h = makeHarness();
    h.orchestrator.registerExecutor(
      'slow',
      new FakeExecutor({
        steps: [{ delayMs: 60_000 }],
        finish: { state: 'finished' },
      })
    );
    const { blocker, dependent } = await finishedBlocker(h);
    const again = await h.orchestrator.dispatch(blocker.meta.id, 'slow');
    try {
      const meta = await h.orchestrator.dispatch(dependent.meta.id, 'fake');
      expect(meta.baseBranch).toBe('main');
      expect(meta.stackParents ?? []).toEqual([]);
    } finally {
      await h.orchestrator.cancel(again.id).catch(() => {});
    }
  });
});

// The 2+-blocker path writes a branch and commits into the user's
// repository, so it gets its own coverage against real git.
describe('base selection with two or more unmerged blockers', () => {
  it('branches off one base holding every blocker, without touching the main checkout', async () => {
    const h = makeHarness();
    const { ids, branches } = await makeInReviewBlockers(h, ['A', 'B', 'C']);
    const dependent = h.store.create({ title: 'dep', blockedBy: ids });
    h.cache.rebuild(h.store);
    const headBefore = runGitSync(repo, ['rev-parse', 'HEAD']).trim();
    const pathsBefore = statusPaths(repo);

    const meta = await h.orchestrator.dispatch(dependent.meta.id, 'fake');

    const base = `dispatch/stack-base-${dependent.meta.id}`;
    expect(meta.baseBranch).toBe(base);
    expect(meta.stackParents).toEqual(branches);
    expect(meta.stackBaseCommit).toBe(
      runGitSync(repo, ['rev-parse', '--verify', base]).trim()
    );
    // One commit over all three blockers, so their history stays intact.
    const parents = runGitSync(repo, ['rev-list', '--parents', '-n', '1', base])
      .trim()
      .split(' ')
      .slice(1);
    expect(parents).toEqual(
      branches.map((b) => runGitSync(repo, ['rev-parse', b]).trim())
    );
    // The agent sees every blocker's work.
    for (const title of ['A', 'B', 'C']) {
      expect(
        await Bun.file(join(meta.worktreePath, `${title}.txt`)).text()
      ).toBe(title);
    }
    // The main checkout stays where it was, with nothing new in it.
    expect(runGitSync(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      'main'
    );
    expect(runGitSync(repo, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(existsSync(join(repo, 'A.txt'))).toBe(false);
    expect(statusPaths(repo)).toEqual(pathsBefore);
  });

  it("rebuilds the base from the blockers' current tips on a re-dispatch", async () => {
    const h = makeHarness();
    const { ids, branches } = await makeInReviewBlockers(h, ['A', 'B']);
    const dependent = h.store.create({ title: 'dep', blockedBy: ids });
    h.cache.rebuild(h.store);
    const first = await h.orchestrator.dispatch(dependent.meta.id, 'fake');
    await waitFor(
      () => h.orchestrator.getRun(first.id)?.meta.state === 'finished'
    );
    h.orchestrator.review(first.id, 'discard');

    // Blocker A gains a commit after the first dispatch.
    const blockerA = h.orchestrator
      .list()
      .find((r) => r.branch === branches[0]);
    if (blockerA === undefined) throw new Error('blocker A has no run');
    await Bun.write(join(blockerA.worktreePath, 'A2.txt'), 'A2');
    runGitSync(blockerA.worktreePath, ['add', '-A']);
    runGitSync(blockerA.worktreePath, ['commit', '-m', 'more A work']);

    const second = await h.orchestrator.dispatch(dependent.meta.id, 'fake');
    expect(second.baseBranch).toBe(first.baseBranch);
    expect(second.stackBaseCommit).not.toBe(first.stackBaseCommit);
    expect(await Bun.file(join(second.worktreePath, 'A2.txt')).text()).toBe(
      'A2'
    );
  });

  // The refusal is an OrchestratorConflictError so that
  // MilestoneEngine.fillQueue's existing `continue` skips the task and
  // retries it on the next pass, and a manual dispatch 409s with a readable
  // reason. Dispatching off `main` instead would be strictly worse: the agent
  // would see neither blocker's work, and a run with no stackParents is never
  // restacked or flagged.
  it('waits when two blockers conflict, naming both and leaving nothing behind', async () => {
    const h = makeHarness();
    const { ids, branches } = await makeInReviewBlockers(
      h,
      ['A', 'B'],
      () => 'shared.txt'
    );
    const dependent = h.store.create({ title: 'dep', blockedBy: ids });
    h.cache.rebuild(h.store);
    const worktreesBefore = runGitSync(repo, ['worktree', 'list']);

    await expect(
      h.orchestrator.dispatch(dependent.meta.id, 'fake')
    ).rejects.toBeInstanceOf(OrchestratorConflictError);
    await expect(
      h.orchestrator.dispatch(dependent.meta.id, 'fake')
    ).rejects.toThrow(
      `blockers ${branches[0]} and ${branches[1]} conflict (shared.txt); waiting until they merge`
    );

    // No run, no stack-base branch, no new worktree.
    expect(h.orchestrator.list()).not.toContainEqual(
      expect.objectContaining({ taskId: dependent.meta.id })
    );
    expect(
      runGitSync(repo, [
        'branch',
        '--list',
        `dispatch/stack-base-${dependent.meta.id}`,
      ]).trim()
    ).toBe('');
    expect(runGitSync(repo, ['worktree', 'list'])).toBe(worktreesBefore);
    // Recorded ONCE, not once per attempt: a waiting task is retried on every
    // fill pass for as long as its blockers stay unmerged.
    expect(
      activityFor(h, dependent.meta.id).split('conflict (shared.txt)')
    ).toHaveLength(2);
  });

  // The Activity write in that failure path is itself a task-file write, and
  // it can fail too (an unwritable file). Reporting a problem must not replace
  // the real, actionable reason with an opaque filesystem error — same
  // swallow-and-log rule MilestoneEngine.recordFillFailure applies.
  it('still refuses with the real reason when recording it on the task fails', async () => {
    const h = makeHarness();
    const { ids } = await makeInReviewBlockers(
      h,
      ['A', 'B'],
      () => 'shared.txt'
    );
    const dependent = h.store.create({ title: 'dep', blockedBy: ids });
    h.cache.rebuild(h.store);

    const file = h.store.taskFilePath(dependent.meta.id)!;
    chmodSync(file, 0o444);
    try {
      await expect(
        h.orchestrator.dispatch(dependent.meta.id, 'fake')
      ).rejects.toThrow('conflict (shared.txt)');
    } finally {
      chmodSync(file, 0o644);
    }
  });
});

// Task 7: discarding a run means a human rejected the work its dependents
// were stacked on. Nothing about the dependent may be touched — only a flag
// that tells a human it needs attention before it can be merged.
describe('discarding a stacked-on run', () => {
  it('flags dependents when the run they were stacked on is discarded', async () => {
    const h = makeHarness();
    const { blockerRun, dependentRun } = await makeStackedPair(h);

    h.orchestrator.review(blockerRun.id, 'discard');

    const dependent = h.orchestrator
      .list()
      .find((r) => r.id === dependentRun.id)!;
    expect(dependent.baseDiscarded).toBe(true);
    // Nothing is destroyed: the worktree and branch are untouched.
    expect(await Bun.file(join(dependent.worktreePath, 'b.txt')).exists()).toBe(
      true
    );
    expect(
      runGitSync(repo, ['rev-parse', '--verify', dependentRun.branch]).trim()
        .length
    ).toBeGreaterThan(0);
    // The reason reaches the user on the dependent's OWN task, not just its
    // (in-memory) run metadata.
    expect(activityFor(h, dependentRun.taskId)).toContain('discarded');
    // Restart-equivalent: the flag survives a transcript replay, the same
    // guarantee flagRunRestackFailure's other call site already has.
    expect(
      replayTranscript(transcriptPath(repo, dependentRun.id))?.meta
        .baseDiscarded
    ).toBe(true);
  });

  // `baseDiscarded` is raised for three different situations and only one of
  // them is an actually-discarded base, so the flag alone cannot be rendered.
  // The reason travels with it — and unlike `error`, it is written
  // unconditionally, so it is still there on a run that already failed for its
  // own reasons.
  it('records why the flag was raised, and the reason survives a replay', async () => {
    const h = makeHarness();
    const { blockerRun, dependentRun } = await makeStackedPair(h);

    h.orchestrator.review(blockerRun.id, 'discard');

    const dependent = h.orchestrator
      .list()
      .find((r) => r.id === dependentRun.id)!;
    expect(dependent.baseDiscardedReason).toContain(blockerRun.id);
    expect(dependent.baseDiscardedReason).toContain('was discarded');
    expect(
      replayTranscript(transcriptPath(repo, dependentRun.id))?.meta
        .baseDiscardedReason
    ).toBe(dependent.baseDiscardedReason);
  });

  // A live dependent is left completely alone. Flagging it would stamp an
  // error chip and a mid-run state line onto a run whose agent is working
  // perfectly happily; the merge queue's stale-run sweep picks it up once the
  // worktree goes quiet instead (covered in merge-queue.test.ts).
  it('does not flag a dependent whose agent is still running', async () => {
    const h = makeHarness();
    const blocker = h.store.create({ title: 'A' });
    const blockerRun = await h.orchestrator.dispatch(blocker.meta.id, 'fake');
    await waitFor(
      () => h.orchestrator.getRun(blockerRun.id)?.meta.state === 'finished'
    );
    await Bun.write(join(blockerRun.worktreePath, 'a.txt'), 'a');
    runGitSync(blockerRun.worktreePath, ['add', '-A']);
    runGitSync(blockerRun.worktreePath, ['commit', '-m', 'A work']);
    h.store.update(
      blocker.meta.id,
      { status: 'review' },
      new Date().toISOString()
    );
    h.cache.rebuild(h.store);

    h.orchestrator.registerExecutor(
      'gated',
      new FakeExecutor({
        steps: [
          { approval: { requestId: 'gate', toolName: 'noop', input: {} } },
        ],
        finish: { state: 'finished' },
      })
    );
    const dependent = h.store.create({
      title: 'B',
      blockedBy: [blocker.meta.id],
    });
    h.cache.rebuild(h.store);
    const dependentRun = await h.orchestrator.dispatch(
      dependent.meta.id,
      'gated'
    );
    await waitFor(
      () =>
        h.orchestrator.getRun(dependentRun.id)?.meta.state ===
        'awaiting-approval'
    );

    h.orchestrator.review(blockerRun.id, 'discard');

    const live = h.orchestrator.list().find((r) => r.id === dependentRun.id)!;
    expect(live.baseDiscarded).toBeUndefined();
    expect(live.error).toBeUndefined();
    // ...and nothing was appended to its transcript mid-run either.
    expect(
      replayTranscript(transcriptPath(repo, dependentRun.id))?.meta
        .baseDiscarded
    ).toBeUndefined();
  });
});
