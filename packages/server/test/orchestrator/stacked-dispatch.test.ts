import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { JjManager } from '../../src/orchestrator/jj.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { transcriptPath } from '../../src/orchestrator/paths.js';
import type { CommandResult } from '../../src/orchestrator/pr.js';
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

// Records every jj command the orchestrator issues and replays canned
// results, so the 2+-blocker path — the only path that mutates the user's
// repository — can be driven without a jj binary. Same shape as
// jj.test.ts's own runner.
function fakeJj(results: Record<string, CommandResult> = {}) {
  const calls: string[][] = [];
  const run = (_cwd: string, cmd: string[]): Promise<CommandResult> => {
    calls.push(cmd);
    return Promise.resolve(
      results[cmd.join(' ')] ?? { ok: true, stdout: '', stderr: '' }
    );
  };
  return { calls, jj: new JjManager(repo, run) };
}

function makeHarness(jj?: JjManager) {
  const store = TaskStore.init(repo);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const orchestrator = new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events,
    jj,
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
  titles: string[]
): Promise<{ ids: string[]; branches: string[] }> {
  const ids: string[] = [];
  const branches: string[] = [];
  for (const title of titles) {
    const task = h.store.create({ title });
    const run = await h.orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => h.orchestrator.getRun(run.id)?.meta.state === 'finished'
    );
    await Bun.write(join(run.worktreePath, `${title}.txt`), title);
    runGitSync(run.worktreePath, ['add', '-A']);
    runGitSync(run.worktreePath, ['commit', '-m', `${title} work`]);
    h.store.update(
      task.meta.id,
      { status: 'in-review' },
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
    { status: 'in-review' },
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
  // `-uall` so an untracked directory is always expanded to its files —
  // otherwise git collapses it to `.dispatch/` before the jj conversion and
  // lists each file after, which would compare unequal for no real reason.
  return runGitSync(dir, ['status', '--porcelain', '-uall'])
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((p) => p.length > 0)
    .sort();
}

// The real-jj test below is the only guard against the merge base relocating
// the user's main checkout, but jj is not a build dependency — skip rather
// than fail where the binary isn't installed.
function hasJj(): boolean {
  return (
    Bun.spawnSync(['jj', '--version'], { stdout: 'pipe', stderr: 'pipe' })
      .exitCode === 0
  );
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

  // The invariant the whole feature is gated on: an unblocked dispatch must
  // behave exactly as it did before stacking existed. Converting a user's
  // repo to jj is invasive, so "no jj involvement of any kind" is asserted
  // directly rather than inferred from the base branch.
  it('never shells out to jj on an unblocked dispatch', async () => {
    const f = fakeJj();
    const h = makeHarness(f.jj);
    const task = h.store.create({ title: 'solo' });
    h.cache.rebuild(h.store);

    await h.orchestrator.dispatch(task.meta.id, 'fake');
    expect(f.calls).toEqual([]);
  });

  it('never shells out to jj on a single-blocker dispatch', async () => {
    const f = fakeJj();
    const h = makeHarness(f.jj);
    const { ids, branches } = await makeInReviewBlockers(h, ['A']);
    const dependent = h.store.create({ title: 'dep', blockedBy: ids });
    h.cache.rebuild(h.store);

    const meta = await h.orchestrator.dispatch(dependent.meta.id, 'fake');
    expect(meta.baseBranch).toBe(branches[0]);
    expect(f.calls).toEqual([]);
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
      { status: 'in-review' },
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
    const blocker = h.store.create({ title: 'A', status: 'done' });
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
    const blocker = h.store.create({ title: 'A', status: 'in-review' });
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

// The 2+-blocker path is the only part of dispatch that mutates the user's
// repository (it can convert it to a colocated jj repo and writes a merge
// commit), so it gets its own coverage rather than being left to inspection.
describe('base selection with two or more unmerged blockers', () => {
  // Spec §4.6: "under the git path a task with two or more unmerged blockers
  // WAITS (today's behavior) rather than dispatching against a wrong base."
  // Dispatching it off `main` would be strictly worse than today — §1 of the
  // spec is the argument for exactly that — because the agent would see
  // NEITHER blocker's work, and a run with no recorded stackParents is
  // afterwards invisible to the merge queue: never restacked, never flagged.
  // The refusal is an OrchestratorConflictError specifically so that
  // EpicEngine.fillQueue's existing `continue` skips the task and retries it
  // on the next pass, and a manual dispatch 409s with a readable reason.
  it('refuses to dispatch when jj is unavailable, so the task waits, and says so on the task', async () => {
    const f = fakeJj({
      'jj --version': { ok: false, stdout: '', stderr: 'command not found' },
      'jj git colocation status': { ok: false, stdout: '', stderr: 'no jj' },
    });
    const h = makeHarness(f.jj);
    const { ids } = await makeInReviewBlockers(h, ['A', 'B']);
    const dependent = h.store.create({ title: 'dep', blockedBy: ids });
    h.cache.rebuild(h.store);

    await expect(
      h.orchestrator.dispatch(dependent.meta.id, 'fake')
    ).rejects.toBeInstanceOf(OrchestratorConflictError);
    await expect(
      h.orchestrator.dispatch(dependent.meta.id, 'fake')
    ).rejects.toThrow('2 unmerged blockers need a multi-parent base');

    // No run was created, and nothing was branched off a wrong base.
    expect(h.orchestrator.list()).not.toContainEqual(
      expect.objectContaining({ taskId: dependent.meta.id })
    );
    expect(activityFor(h, dependent.meta.id)).toContain(
      'which only jj can build'
    );
    // It must never try to build the merge base after bailing out.
    expect(f.calls.map((c) => c.join(' '))).not.toContain(
      'jj new -r dispatch/a -r dispatch/b --no-edit'
    );
  });

  it('builds a multi-parent base via jj and records both parents', async () => {
    const f = fakeJj({
      'jj git colocation status': { ok: true, stdout: 'colocated', stderr: '' },
      'jj --version': { ok: true, stdout: 'jj 0.43.0', stderr: '' },
    });
    const h = makeHarness(f.jj);
    const { ids, branches } = await makeInReviewBlockers(h, ['A', 'B']);
    const dependent = h.store.create({ title: 'dep', blockedBy: ids });
    h.cache.rebuild(h.store);

    // The stub never runs real jj, so stand the bookmark up as a real git ref
    // for `git worktree add` / resolveCommit to find. What the orchestrator is
    // responsible for — the exact jj argument vector, and threading the
    // resulting ref through as the base — is what's asserted here; that the
    // vector does the right thing to a real repo is covered by jj.test.ts and
    // by the real-jj test below.
    const bookmark = `dispatch/stack-base-${dependent.meta.id}`;
    runGitSync(repo, ['branch', bookmark, branches[0]]);

    const meta = await h.orchestrator.dispatch(dependent.meta.id, 'fake');
    expect(meta.baseBranch).toBe(bookmark);
    expect(meta.stackParents).toEqual(branches);
    expect(meta.stackBaseCommit).toBe(
      runGitSync(repo, ['rev-parse', '--verify', bookmark]).trim()
    );
    expect(f.calls.map((c) => c.join(' '))).toEqual([
      'jj git colocation status',
      'jj --version',
      'jj git colocation status',
      `jj new -r ${branches[0]} -r ${branches[1]} --no-edit`,
      `jj bookmark set ${bookmark} -r latest(children(${branches[0]}) & children(${branches[1]})) --allow-backwards`,
      'jj git export',
    ]);
    // Already colocated — no conversion, so no conversion notice.
    expect(activityFor(h, dependent.meta.id)).not.toContain(
      'converted this repository'
    );
  });

  it('records an Activity line when it converts the repository to colocated jj', async () => {
    let colocated = false;
    const calls: string[][] = [];
    const run = (_cwd: string, cmd: string[]): Promise<CommandResult> => {
      calls.push(cmd);
      const key = cmd.join(' ');
      if (key === 'jj git colocation status') {
        return Promise.resolve({
          ok: colocated,
          stdout: '',
          stderr: 'not colocated',
        });
      }
      if (key === 'jj git init --colocate') colocated = true;
      return Promise.resolve({ ok: true, stdout: '', stderr: '' });
    };
    const h = makeHarness(new JjManager(repo, run));
    const { ids, branches } = await makeInReviewBlockers(h, ['A', 'B']);
    const dependent = h.store.create({ title: 'dep', blockedBy: ids });
    h.cache.rebuild(h.store);
    const bookmark = `dispatch/stack-base-${dependent.meta.id}`;
    runGitSync(repo, ['branch', bookmark, branches[0]]);

    const meta = await h.orchestrator.dispatch(dependent.meta.id, 'fake');
    expect(meta.baseBranch).toBe(bookmark);
    expect(calls.map((c) => c.join(' '))).toContain('jj git init --colocate');
    expect(activityFor(h, dependent.meta.id)).toContain(
      'converted this repository to a colocated jj repo'
    );
  });

  // No jj failure may turn an otherwise valid dispatch into an opaque 500 —
  // every one converges on the same typed refusal the jj-unavailable case
  // raises, carrying jj's own error text so the reason is actionable.
  it('refuses with the jj error text when a jj command fails mid-way', async () => {
    // `jj new` is stubbed to fail, which makes JjManager.mergeBase throw.
    // Before this was contained, that rejection escaped dispatch() as a 500.
    const h = makeHarness(
      new JjManager(repo, (_cwd, cmd) =>
        Promise.resolve(
          cmd[1] === 'new'
            ? {
                ok: false,
                stdout: '',
                stderr: 'Error: Revision `dispatch/a` does not exist',
              }
            : { ok: true, stdout: '', stderr: '' }
        )
      )
    );
    const { ids } = await makeInReviewBlockers(h, ['A', 'B']);
    const dependent = h.store.create({ title: 'dep', blockedBy: ids });
    h.cache.rebuild(h.store);

    await expect(
      h.orchestrator.dispatch(dependent.meta.id, 'fake')
    ).rejects.toBeInstanceOf(OrchestratorConflictError);
    expect(activityFor(h, dependent.meta.id)).toContain(
      '2 unmerged blockers need a multi-parent base'
    );
    expect(activityFor(h, dependent.meta.id)).toContain('jj new failed');
  });

  // The Activity write in that failure path is itself a task-file write, and
  // it can fail too (an unwritable file). Reporting a problem must not replace
  // the real, actionable reason with an opaque filesystem error — same
  // swallow-and-log rule EpicEngine.recordFillFailure applies.
  it('still refuses with the real reason when recording it on the task fails', async () => {
    const f = fakeJj({
      'jj --version': { ok: false, stdout: '', stderr: 'command not found' },
      'jj git colocation status': { ok: false, stdout: '', stderr: 'no jj' },
    });
    const h = makeHarness(f.jj);
    const { ids } = await makeInReviewBlockers(h, ['A', 'B']);
    const dependent = h.store.create({ title: 'dep', blockedBy: ids });
    h.cache.rebuild(h.store);

    const file = h.store.taskFilePath(dependent.meta.id)!;
    chmodSync(file, 0o444);
    try {
      await expect(
        h.orchestrator.dispatch(dependent.meta.id, 'fake')
      ).rejects.toBeInstanceOf(OrchestratorConflictError);
    } finally {
      chmodSync(file, 0o644);
    }
  });

  // Real jj, real repo — the only thing that can actually catch a regression
  // where building the merge base relocates or dirties the user's MAIN
  // checkout, which a stubbed CommandRunner is blind to by construction.
  it.skipIf(!hasJj())(
    'builds the merge base without moving or dirtying the main checkout',
    async () => {
      const h = makeHarness();
      const { ids, branches } = await makeInReviewBlockers(h, ['A', 'B']);
      const dependent = h.store.create({ title: 'dep', blockedBy: ids });
      h.cache.rebuild(h.store);

      const headBefore = runGitSync(repo, ['rev-parse', 'HEAD']).trim();
      const pathsBefore = statusPaths(repo);

      const meta = await h.orchestrator.dispatch(dependent.meta.id, 'fake');

      // Critical: the main checkout must be exactly where it was — still on
      // the same branch, still at the same commit. A bare `jj new` (no
      // `--no-edit`) moves it onto the merge commit and detaches it, which
      // then makes mergeRun's branch guard refuse every later merge.
      expect(
        runGitSync(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
      ).toBe('main');
      expect(runGitSync(repo, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);

      // And none of the blockers' files may be materialized into it.
      expect(existsSync(join(repo, 'A.txt'))).toBe(false);
      expect(existsSync(join(repo, 'B.txt'))).toBe(false);

      // Dispatch introduces no new pending paths. NOTE: the colocation
      // conversion itself does re-stage paths that were already untracked
      // (jj snapshots the working copy on init), so the status *letters* can
      // change; the set of affected paths must not.
      expect(statusPaths(repo)).toEqual(pathsBefore);

      // And the dependent really does get BOTH blockers' work — the point of
      // the multi-parent base in the first place.
      expect(meta.baseBranch).toBe(`dispatch/stack-base-${dependent.meta.id}`);
      expect(meta.stackParents).toEqual(branches);
      expect(await Bun.file(join(meta.worktreePath, 'A.txt')).text()).toBe('A');
      expect(await Bun.file(join(meta.worktreePath, 'B.txt')).text()).toBe('B');
    }
  );
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
      { status: 'in-review' },
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
