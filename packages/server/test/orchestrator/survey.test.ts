import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import {
  BOOT_FORCE_FAIL_ERROR,
  Orchestrator,
} from '../../src/orchestrator/orchestrator.js';
import type {
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
} from '../../src/orchestrator/types.js';
import { initGitRepo, runGitSync, StallingExecutor } from './helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo();
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

function makeOrchestrator(rootDir: string): {
  orchestrator: Orchestrator;
  store: TaskStore;
} {
  const store = TaskStore.init(rootDir);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const orchestrator = new Orchestrator({ rootDir, store, cache, events });
  return { orchestrator, store };
}

/**
 * Makes the auto-commit safety net genuinely fail, so a run reaches its
 * terminal state with work still sitting in the worktree.
 *
 * An empty identity, rather than the rejecting `pre-commit` hook this used to
 * install: the safety net commits with `--no-verify` (a run worktree has no
 * node_modules, so a project's own hooks fail there for reasons that have
 * nothing to do with the content), which means a hook is no longer able to
 * strand a run's work — the case this file is about. `git commit` still refuses
 * outright with no author, and leaves the `git add -A` staged behind it.
 */
function breakGitIdentity(repoDir: string): void {
  runGitSync(repoDir, ['config', 'user.email', '']);
  runGitSync(repoDir, ['config', 'user.name', '']);
}

// Starts and just sits there — never calls onFinish on its own — so a
// dispatched run stays 'running' until something else (a reboot) acts on it.
function controllableExecutor(): Executor {
  return {
    start(): ExecutorRun {
      return {
        interrupt: () => Promise.resolve(),
        requestStop: () => {},
        send: () => {},
        approve: () => {},
      };
    },
  };
}

class CapturingExecutor implements Executor {
  captured: ExecutorStartOptions[] = [];

  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    this.captured.push(opts);
    events.onFinish({ state: 'finished' });
    return {
      interrupt: () => Promise.resolve(),
      requestStop: () => {},
      send: () => {},
      approve: () => {},
    };
  }
}

describe('Orchestrator.surveyRun', () => {
  it('reports staged/unstaged/untracked paths and the last commit', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'tracked.txt'), 'v1\n');
            },
            commitMessage: 'agent: add tracked.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Survey me' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    // Dirty the worktree by hand, independent of any executor: one staged
    // file, one modified-but-unstaged tracked file, one untracked file.
    writeFileSync(join(meta.worktreePath, 'staged.txt'), 'new\n');
    runGitSync(meta.worktreePath, ['add', 'staged.txt']);
    writeFileSync(join(meta.worktreePath, 'tracked.txt'), 'v2\n');
    writeFileSync(join(meta.worktreePath, 'new.txt'), 'untracked\n');

    const survey = await orchestrator.surveyRun(meta.id);

    expect(survey.runId).toBe(meta.id);
    expect(survey.branch).toBe(meta.branch);
    expect(survey.staged).toEqual(['staged.txt']);
    expect(survey.unstaged).toEqual(['tracked.txt']);
    expect(survey.untracked).toEqual(['new.txt']);
    expect(survey.cleanTree).toBe(false);
    expect(survey.lastCommit?.subject).toBe('agent: add tracked.txt');
  });
});

describe('Orchestrator agent-death recovery', () => {
  it('marks a failed run with leftover uncommitted work as interrupted-dirty', async () => {
    breakGitIdentity(repo);
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'oops.txt'), 'leftover\n');
            },
            // The agent never got to commit this — the scenario a dropped
            // connection or a stall watchdog leaves behind.
            commit: false,
          },
        ],
        finish: { state: 'failed', error: 'connection dropped' },
      })
    );
    const task = store.create({ title: 'Dies mid-write' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');

    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'interrupted-dirty'
    );

    const run = orchestrator.getRun(meta.id)!;
    // The executor's own diagnosis survives; the commit failure is appended,
    // not substituted for it.
    expect(run.meta.error).toContain('connection dropped');
    expect(run.meta.error).toContain('finish failed');
    expect(run.meta.survey?.cleanTree).toBe(false);
    // autoCommitIfDirty's `git add -A` still ran (only the doomed `commit`
    // failed), so the file shows up staged rather than untracked.
    expect(run.meta.survey?.staged).toEqual(['oops.txt']);
    expect(store.get(task.meta.id)!.meta.status).toBe('review');
    // The synchronous finish line still says `failed`; the upgrade to
    // `interrupted-dirty` lands as its own later Activity line.
    expect(store.get(task.meta.id)!.body).toContain(
      `[run ${meta.id}] finished: failed`
    );
    expect(store.get(task.meta.id)!.body).toContain(
      `[run ${meta.id}] flagged interrupted-dirty: 1 uncommitted path(s) found`
    );
  });

  it("resumes a dirty run into the same worktree with the survey in the agent's prompt", async () => {
    breakGitIdentity(repo);
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'oops.txt'), 'leftover\n');
            },
            commit: false,
          },
        ],
        finish: { state: 'failed', error: 'connection dropped' },
      })
    );
    const task = store.create({ title: 'Dies mid-write' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'interrupted-dirty'
    );

    const capturing = new CapturingExecutor();
    orchestrator.registerExecutor('fake', capturing);
    const resumed = await orchestrator.resumeRun(meta.id);

    expect(resumed.worktreePath).toBe(meta.worktreePath);
    expect(resumed.branch).toBe(meta.branch);
    expect(resumed.resumedFrom).toBe(meta.id);
    expect(capturing.captured[0]?.prompt).toContain(
      '## Recovered state from the previous run'
    );
    expect(capturing.captured[0]?.prompt).toContain('oops.txt');
  });

  it('resumes a cleanly finished run without a survey section in the prompt', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'done.txt'), 'ok\n');
            },
            commitMessage: 'agent: finish cleanly',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Finishes cleanly' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );
    expect(orchestrator.getRun(meta.id)?.meta.survey).toBeUndefined();

    const capturing = new CapturingExecutor();
    orchestrator.registerExecutor('fake', capturing);
    const resumed = await orchestrator.resumeRun(meta.id);

    expect(resumed.resumedFrom).toBe(meta.id);
    expect(capturing.captured[0]?.prompt).not.toContain(
      '## Recovered state from the previous run'
    );
  });

  it('surveys a dirty run left non-terminal by a daemon crash, via reconcileOnBoot', async () => {
    const { orchestrator: first, store } = makeOrchestrator(repo);
    first.registerExecutor('fake', controllableExecutor());
    const task = store.create({ title: 'Daemon dies mid-run' });
    const meta = await first.dispatch(task.meta.id, 'fake');
    expect(first.getRun(meta.id)?.meta.state).toBe('running');

    // The agent left real, uncommitted work behind — the shape a genuine
    // mid-task daemon crash leaves, as opposed to a freshly empty worktree.
    writeFileSync(join(meta.worktreePath, 'oops.txt'), 'leftover\n');

    const cache2 = new TaskCache();
    cache2.rebuild(store);
    const events2 = new EventBus();
    const second = new Orchestrator({
      rootDir: repo,
      store,
      cache: cache2,
      events: events2,
    });
    second.reconcileOnBoot();
    // reconcileOnBoot() itself is synchronous and force-fails immediately;
    // the survey that upgrades it lands afterward, in the background.
    expect(second.getRun(meta.id)?.meta.state).toBe('failed');

    await waitFor(
      () => second.getRun(meta.id)?.meta.state === 'interrupted-dirty'
    );
    const survey = second.getRun(meta.id)?.meta.survey;
    expect(survey?.untracked).toEqual(['oops.txt']);
    expect(store.get(task.meta.id)!.body).toContain(
      `[run ${meta.id}] flagged interrupted-dirty: 1 uncommitted path(s) found`
    );
  });

  it('force-fails a crashed run with a reason naming the daemon restart', async () => {
    const { orchestrator: first, store } = makeOrchestrator(repo);
    first.registerExecutor('fake', controllableExecutor());
    const task = store.create({ title: 'Daemon dies mid-run' });
    const meta = await first.dispatch(task.meta.id, 'fake');

    const cache2 = new TaskCache();
    cache2.rebuild(store);
    const second = new Orchestrator({
      rootDir: repo,
      store,
      cache: cache2,
      events: new EventBus(),
    });
    second.reconcileOnBoot();

    const failed = second.getRun(meta.id);
    expect(failed?.meta.state).toBe('failed');
    expect(failed?.meta.error).toBe(BOOT_FORCE_FAIL_ERROR);

    // The reason rode the transcript's state line, so it survives yet
    // another restart — not just the registry that happened to write it.
    const cache3 = new TaskCache();
    cache3.rebuild(store);
    const third = new Orchestrator({
      rootDir: repo,
      store,
      cache: cache3,
      events: new EventBus(),
    });
    third.reconcileOnBoot();
    expect(third.getRun(meta.id)?.meta.error).toBe(BOOT_FORCE_FAIL_ERROR);
  });

  it('flags commits an orphaned agent lands after the force-fail, without re-noting them', async () => {
    const { orchestrator: first, store } = makeOrchestrator(repo);
    first.registerExecutor('fake', controllableExecutor());
    const task = store.create({ title: 'Orphan finishes the work' });
    const meta = await first.dispatch(task.meta.id, 'fake');

    const cache2 = new TaskCache();
    cache2.rebuild(store);
    const second = new Orchestrator({
      rootDir: repo,
      store,
      cache: cache2,
      events: new EventBus(),
    });
    second.reconcileOnBoot();
    // The boot survey sees a clean, commit-less worktree: nothing stamped.
    // Checked via list() rather than getRun(), which would schedule a recheck
    // survey of its own and race the explicit one below.
    await second.surveySettled(meta.id);
    expect(second.list().find((r) => r.id === meta.id)?.survey).toBeUndefined();

    // The orphaned agent process kept working and committed. The author date
    // is pinned a minute into the future because git dates have one-second
    // granularity — a same-second commit could otherwise sort before the
    // millisecond-precision fail timestamp and make this flake.
    writeFileSync(join(meta.worktreePath, 'done.txt'), 'done\n');
    runGitSync(meta.worktreePath, ['add', 'done.txt']);
    runGitSync(meta.worktreePath, [
      'commit',
      `--date=${new Date(Date.now() + 60_000).toISOString()}`,
      '-m',
      'Done, committed',
    ]);

    await second.resurveyOrphanWork(meta.id);

    const run = second.getRun(meta.id)!;
    // Stays failed — the daemon really did lose it — but now says the work landed.
    expect(run.meta.state).toBe('failed');
    expect(run.meta.survey?.postFailCommits?.map((c) => c.subject)).toEqual([
      'Done, committed',
    ]);
    expect(store.get(task.meta.id)!.body).toContain(
      `[run ${meta.id}] work landed on this branch after the failure: 1 commit(s), latest "Done, committed"`
    );

    // A repeat survey that finds the same commits changes nothing — the
    // cooldown-gated recheck from getRun must not re-note the discovery.
    await second.resurveyOrphanWork(meta.id);
    const notes = store
      .get(task.meta.id)!
      .body.split('work landed on this branch after the failure').length;
    expect(notes).toBe(2);
  });

  it('does not stamp a superseded run with a survey of the resumed run’s tree', async () => {
    const { orchestrator: first, store } = makeOrchestrator(repo);
    first.registerExecutor('fake', controllableExecutor());
    const task = store.create({ title: 'Resumed before its survey landed' });
    const meta = await first.dispatch(task.meta.id, 'fake');
    writeFileSync(join(meta.worktreePath, 'oops.txt'), 'leftover\n');

    const cache2 = new TaskCache();
    cache2.rebuild(store);
    const second = new Orchestrator({
      rootDir: repo,
      store,
      cache: cache2,
      events: new EventBus(),
    });
    second.registerExecutor('fake', controllableExecutor());
    // Both calls are synchronous, so the resume lands inside the window the
    // scheduled survey opens — the same tens-of-ms race a fast human wins.
    second.reconcileOnBoot();
    const resumed = second.resumeRun(meta.id);

    expect(resumed.worktreePath).toBe(meta.worktreePath);
    // Waited out rather than slept past: the survey resolves against a worktree
    // that is now the resumed run's, so the superseded run keeps its own state.
    await second.surveySettled(meta.id);
    expect(second.getRun(meta.id)?.meta.state).toBe('failed');
    expect(second.getRun(meta.id)?.meta.survey).toBeUndefined();
    expect(store.get(task.meta.id)!.body).not.toContain(
      'flagged interrupted-dirty'
    );
  });
});

// reconcileOnBoot's recovery half: the run a restart force-failed is picked
// back up rather than left dead. The end-to-end restart, and the deferral while
// an orphaned agent is still writing, are covered over the real HTTP surface in
// test/resilience.test.ts; these cover the eligibility rules directly, where
// each one can be isolated.
describe('Orchestrator boot auto-resume', () => {
  // The second daemon: a fresh Orchestrator over the same store and repo, with
  // the quiet window squeezed down so a test can wait one out. `maxAttempts`
  // is how many quiet windows it will spend on a worktree that keeps moving.
  function reboot(
    store: TaskStore,
    opts: { autoResumeMaxAttempts?: number; autoResumeQuietMs?: number } = {}
  ): Orchestrator {
    const cache = new TaskCache();
    cache.rebuild(store);
    const orchestrator = new Orchestrator({
      rootDir: repo,
      store,
      cache,
      events: new EventBus(),
      autoResumeQuietMs: 10,
      ...opts,
    });
    orchestrator.registerExecutor('fake', new StallingExecutor());
    return orchestrator;
  }

  it('resumes a crashed run in its own worktree once the tree stops moving', async () => {
    const { orchestrator: first, store } = makeOrchestrator(repo);
    first.registerExecutor('fake', new StallingExecutor());
    const task = store.create({ title: 'Daemon dies mid-run' });
    const meta = await first.dispatch(task.meta.id, 'fake');

    const second = reboot(store);
    second.reconcileOnBoot();
    await second.autoResumeSettled(meta.id);

    const successor = second.list().find((r) => r.resumedFrom === meta.id);
    expect(successor?.worktreePath).toBe(meta.worktreePath);
    expect(successor?.branch).toBe(meta.branch);
    expect(successor?.state).toBe('running');
    // Attributed to the restart rather than to whichever human's daemon
    // happened to reboot — nobody asked for this one.
    expect(store.get(task.meta.id)!.body).toContain(
      `auto-resumed after failed (daemon restart) (run ${successor!.id})`
    );
  });

  it('refuses a run that never reported a session, having nothing to pick up', async () => {
    const { orchestrator: first, store } = makeOrchestrator(repo);
    // controllableExecutor, deliberately: it never calls onSession.
    first.registerExecutor('fake', controllableExecutor());
    const task = store.create({ title: 'Died before the agent started' });
    const meta = await first.dispatch(task.meta.id, 'fake');

    const second = reboot(store);
    second.reconcileOnBoot();
    await second.autoResumeSettled(meta.id);

    expect(second.list().some((r) => r.resumedFrom === meta.id)).toBe(false);
    expect(second.getRun(meta.id)?.meta.state).toBe('failed');
    expect(second.resumeBlockReason(second.getRun(meta.id)!.meta)).toBe(
      'run never started a session'
    );
  });

  it('leaves a run alone once a human has reviewed it', async () => {
    const { orchestrator: first, store } = makeOrchestrator(repo);
    first.registerExecutor('fake', new StallingExecutor());
    const task = store.create({ title: 'Reviewed before the sweep got there' });
    const meta = await first.dispatch(task.meta.id, 'fake');

    const second = reboot(store);
    second.reconcileOnBoot();
    // Discarding is synchronous, so it lands inside the window the sweep's
    // first quiet wait opens — the same race a fast human wins.
    second.review(meta.id, 'discard');
    await second.autoResumeSettled(meta.id);

    expect(second.list().some((r) => r.resumedFrom === meta.id)).toBe(false);
  });

  it('abandons the sweep when the daemon it belongs to shuts down', async () => {
    const { orchestrator: first, store } = makeOrchestrator(repo);
    first.registerExecutor('fake', new StallingExecutor());
    const task = store.create({ title: 'Daemon stops mid-sweep' });
    const meta = await first.dispatch(task.meta.id, 'fake');

    const second = reboot(store);
    second.reconcileOnBoot();
    // The sweep sleeps through a quiet window before it can resume anything,
    // so a shutdown lands well inside it — and must stop the sweep, because
    // what it would do next is start an agent under a daemon that is going
    // away and will not be there to supervise it.
    second.shutdown();
    await second.autoResumeSettled(meta.id);

    expect(second.list().some((r) => r.resumedFrom === meta.id)).toBe(false);
  });

  it('gives up rather than looping forever, and says so on the task', async () => {
    const { orchestrator: first, store } = makeOrchestrator(repo);
    first.registerExecutor('fake', new StallingExecutor());
    const task = store.create({ title: 'Orphan never goes quiet' });
    const meta = await first.dispatch(task.meta.id, 'fake');

    const second = reboot(store, { autoResumeMaxAttempts: 3 });
    second.reconcileOnBoot();
    // An orphan rewriting a file it had ALREADY dirtied: no new path, no new
    // sha, nothing a name-only fingerprint would notice — which is exactly the
    // case that has to keep the sweep from calling this tree quiet. It runs no
    // git of its own on purpose, so the only git touching this worktree is the
    // sweep's own evidence gathering and there is nothing to lose an
    // `index.lock` race against.
    let stillGoing = true;
    let rewrites = 0;
    const orphan = (async () => {
      while (stillGoing) {
        writeFileSync(
          join(meta.worktreePath, 'README.md'),
          `# test repo\nstill writing ${rewrites}\n`
        );
        rewrites++;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();
    await second.autoResumeSettled(meta.id);
    stillGoing = false;
    await orphan;
    expect(rewrites).toBeGreaterThan(3);

    expect(second.list().some((r) => r.resumedFrom === meta.id)).toBe(false);
    expect(store.get(task.meta.id)!.body).toContain(
      `[run ${meta.id}] not auto-resumed after the daemon restart`
    );
  });

  it('never reads a worktree it cannot inspect as a quiet one', async () => {
    const { orchestrator: first, store } = makeOrchestrator(repo);
    first.registerExecutor('fake', new StallingExecutor());
    const task = store.create({ title: 'Unreadable worktree' });
    const meta = await first.dispatch(task.meta.id, 'fake');

    const second = reboot(store, { autoResumeMaxAttempts: 3 });
    second.reconcileOnBoot();
    // A linked worktree's `.git` is a FILE pointing at its real gitdir, so
    // garbage in it makes every git command there fail while the directory
    // itself stays put — the run still looks resumable, and the only thing
    // between it and a resume is that its evidence cannot be read. Two
    // unreadable samples in a row must not compare equal into "nobody is
    // writing": a git failure is evidence of activity if it is evidence of
    // anything.
    writeFileSync(join(meta.worktreePath, '.git'), 'gitdir: /nonexistent\n');
    await second.autoResumeSettled(meta.id);

    expect(second.list().some((r) => r.resumedFrom === meta.id)).toBe(false);
  });

  it('leaves a task a human cancelled during the quiet window alone', async () => {
    const { orchestrator: first, store } = makeOrchestrator(repo);
    first.registerExecutor('fake', new StallingExecutor());
    const task = store.create({ title: 'Cancelled mid-sweep' });
    const meta = await first.dispatch(task.meta.id, 'fake');

    const second = reboot(store);
    second.reconcileOnBoot();
    // The sweep sleeps through a quiet window before it can resume anything,
    // so this lands well inside it — and a resume would drag the task the
    // human just closed out back to in-progress.
    store.update(task.meta.id, { status: 'dropped' }, new Date().toISOString());
    await second.autoResumeSettled(meta.id);

    expect(second.list().some((r) => r.resumedFrom === meta.id)).toBe(false);
    expect(store.get(task.meta.id)!.meta.status).toBe('dropped');
    expect(second.resumeBlockReason(second.getRun(meta.id)!.meta)).toBe(
      'task is dropped'
    );
  });

  // The re-dispatch path has to answer to the same quiescence proof the sweep
  // does: resuming the instant a user asks would drop a second agent into a
  // worktree the orphan may still own, and the sweep would then find the run
  // "already resumed" and quietly stand down.
  it('refuses a re-dispatch until the sweep has watched the worktree settle', async () => {
    const { orchestrator: first, store } = makeOrchestrator(repo);
    first.registerExecutor('fake', new StallingExecutor());
    const task = store.create({ title: 'Re-dispatched mid-recovery' });
    const meta = await first.dispatch(task.meta.id, 'fake');

    // Rebooted with the sweep held off, so nothing has proved anything yet.
    const second = reboot(store, { autoResumeQuietMs: 60_000 });
    second.reconcileOnBoot();
    await second.surveySettled(meta.id);

    await expect(
      second.dispatchOrResume(task.meta.id, { executor: 'fake' })
    ).rejects.toThrow(/being recovered after a daemon restart/);
    expect(second.list().some((r) => r.resumedFrom === meta.id)).toBe(false);

    // `fresh` is the way through: it never touches the contested worktree.
    const fresh = await second.dispatchOrResume(task.meta.id, {
      executor: 'fake',
      fresh: true,
    });
    expect(fresh.resumedFrom).toBeUndefined();
    expect(fresh.worktreePath).not.toBe(meta.worktreePath);
  });
});

// The resume-vs-fresh decision itself, on a run that failed with its daemon
// alive: no restart means no orphaned agent, so no quiescence proof is owed
// and what is left is purely whether a resume can give the caller what it
// asked for.
describe('Orchestrator.dispatchOrResume', () => {
  // Dispatches a run on 'fake' that commits its work and then fails, leaving
  // exactly the resumable run these tests re-dispatch against.
  async function failedRunOn(
    orchestrator: Orchestrator,
    store: TaskStore,
    title: string,
    model?: string
  ): Promise<{ taskId: string; runId: string }> {
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        session: 'session-1',
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'work.txt'), 'nearly done\n');
            },
            commitMessage: 'agent: nearly done',
          },
        ],
        // Reported on the finish as well as up front: handleFinish folds the
        // finish's own `sessionId` over the meta, so a script that only
        // announces one at the start ends up with none recorded — same as a
        // real executor, which reports its session on the way out too.
        finish: {
          state: 'failed',
          error: 'connection dropped',
          sessionId: 'session-1',
        },
      })
    );
    const task = store.create({ title });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake', { model });
    await waitFor(() => orchestrator.getRun(meta.id)?.meta.state === 'failed');
    // The successor must stay live rather than failing again instantly, or the
    // assertions below cannot tell a resume from a second fresh dispatch.
    orchestrator.registerExecutor('fake', new StallingExecutor());
    return { taskId: task.meta.id, runId: meta.id };
  }

  it('resumes when the caller names nothing, whatever executor the run used', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const { taskId, runId } = await failedRunOn(orchestrator, store, 'Plain');

    // No executor named at all — the shape a bare `dispatch run <taskId>`
    // arrives in once the CLI stops sending its flag's default. The run is on
    // 'fake', which is nothing like the daemon default, and it still resumes.
    const resumed = await orchestrator.dispatchOrResume(taskId, {});

    expect(resumed.resumedFrom).toBe(runId);
    expect(resumed.executor).toBe('fake');
  });

  it('resumes when the named model is the one the run already used', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const { taskId, runId } = await failedRunOn(
      orchestrator,
      store,
      'Same model',
      'claude-sonnet-5'
    );

    const resumed = await orchestrator.dispatchOrResume(taskId, {
      executor: 'fake',
      model: 'claude-sonnet-5',
    });

    expect(resumed.resumedFrom).toBe(runId);
    expect(resumed.model).toBe('claude-sonnet-5');
  });

  it('starts fresh when the caller names a different model', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const { taskId, runId } = await failedRunOn(
      orchestrator,
      store,
      'Retried on a stronger model',
      'claude-sonnet-5'
    );

    // A resume keeps the run's own model, so honouring this ask needs a fresh
    // run. Silently resuming would hand the user back the model they were
    // trying to get away from.
    const upgraded = await orchestrator.dispatchOrResume(taskId, {
      executor: 'fake',
      model: 'claude-opus-5',
    });

    expect(upgraded.resumedFrom).toBeUndefined();
    expect(upgraded.model).toBe('claude-opus-5');
    expect(orchestrator.getRun(runId)?.meta.state).toBe('failed');
  });

  it('starts fresh when the caller names a different executor', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const { taskId } = await failedRunOn(orchestrator, store, 'Other executor');
    orchestrator.registerExecutor('other', new StallingExecutor());

    const switched = await orchestrator.dispatchOrResume(taskId, {
      executor: 'other',
    });

    expect(switched.resumedFrom).toBeUndefined();
    expect(switched.executor).toBe('other');
  });

  it('falls back to the default executor for a task with nothing to resume', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor('claude', new StallingExecutor());
    const task = store.create({ title: 'Never run before' });

    const meta = await orchestrator.dispatchOrResume(task.meta.id, {});

    expect(meta.resumedFrom).toBeUndefined();
    expect(meta.executor).toBe('claude');
  });
});
