import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { JjManager } from '../../src/orchestrator/jj.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import type { CommandResult } from '../../src/orchestrator/pr.js';
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
  it('falls back to the default base when jj is unavailable, and says so on the task', async () => {
    const f = fakeJj({
      'jj --version': { ok: false, stdout: '', stderr: 'command not found' },
      'jj git colocation status': { ok: false, stdout: '', stderr: 'no jj' },
    });
    const h = makeHarness(f.jj);
    const { ids } = await makeInReviewBlockers(h, ['A', 'B']);
    const dependent = h.store.create({ title: 'dep', blockedBy: ids });
    h.cache.rebuild(h.store);

    const meta = await h.orchestrator.dispatch(dependent.meta.id, 'fake');
    expect(meta.baseBranch).toBe('main');
    expect(meta.stackParents ?? []).toEqual([]);
    expect(meta.stackBaseCommit).toBeUndefined();
    expect(activityFor(h, dependent.meta.id)).toContain(
      '2 unmerged blockers need a multi-parent base, but jj is unavailable — using main'
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

  // No jj failure may turn an otherwise valid dispatch into a 500 — every one
  // degrades to the same default base the jj-unavailable case uses.
  it('falls back to the default base when a jj command fails mid-way', async () => {
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

    const meta = await h.orchestrator.dispatch(dependent.meta.id, 'fake');
    expect(meta.baseBranch).toBe('main');
    expect(meta.stackParents ?? []).toEqual([]);
    expect(meta.stackBaseCommit).toBeUndefined();
    expect(activityFor(h, dependent.meta.id)).toContain(
      'building a multi-parent base over 2 unmerged blockers failed'
    );
    expect(activityFor(h, dependent.meta.id)).toContain('jj new failed');
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
