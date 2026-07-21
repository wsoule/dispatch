import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  appendFileSync,
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
import {
  runsDir,
  transcriptPath,
  worktreesDir,
} from '../../src/orchestrator/paths.js';
import { Transcript } from '../../src/orchestrator/transcript.js';
import type {
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
  RunMeta,
} from '../../src/orchestrator/types.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from '../../src/orchestrator/types.js';
import { initGitRepo, runGitSync } from './helpers.js';

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

// Waits for `check` to return true, polling — the orchestrator's FakeExecutor
// runs its script asynchronously (fire-and-forget from dispatch/sendMessage),
// so tests must wait for state to settle rather than asserting immediately.
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
  cache: TaskCache;
  events: EventBus;
} {
  const store = TaskStore.init(rootDir);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const orchestrator = new Orchestrator({ rootDir, store, cache, events });
  return { orchestrator, store, cache, events };
}

describe('Orchestrator.dispatch full lifecycle', () => {
  it('provisions a worktree, runs the script, and writes Activity/status on both ends', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'feature.txt'), 'done\n');
            },
            commitMessage: 'agent: add feature',
          },
        ],
        finish: { state: 'finished', costUsd: 1.23, turns: 4 },
      })
    );
    const task = store.create({ title: 'Add feature' });

    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    // A no-approval FakeExecutor script runs synchronously to completion
    // inside `start()` (no `await` point until an approval gate), so by the
    // time `dispatch()` returns the run may already be 'finished' — only a
    // real streaming executor would still be mid-flight here. Either way,
    // `waitFor` below settles on the final state.
    expect(existsSync(meta.worktreePath)).toBe(true);

    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    const finishedTask = store.get(task.meta.id)!;
    expect(finishedTask.meta.status).toBe('in-review');
    expect(finishedTask.body).toContain(
      `dispatched (fake, branch ${meta.branch})`
    );
    expect(finishedTask.body).toMatch(
      /\[run r-[0-9a-f]{6}\] finished: finished — 1 files, \$1\.23/
    );

    const replay = orchestrator.getRun(meta.id)!;
    expect(replay.meta.costUsd).toBe(1.23);
    expect(replay.meta.turns).toBe(4);
  });
});

describe('Orchestrator approval round-trip', () => {
  it('pauses at awaiting-approval and resumes once approved', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            approval: {
              requestId: 'req-1',
              toolName: 'edit_file',
              input: { path: 'x' },
            },
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Needs approval' });
    const meta = orchestrator.dispatch(task.meta.id, 'fake');

    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'awaiting-approval'
    );

    orchestrator.approve(meta.id, 'req-1', true);
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('finished');
  });
});

describe('Orchestrator.cancel', () => {
  it('interrupts a live run and marks it cancelled without closing the task', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [{ approval: { requestId: 'never', toolName: 't', input: {} } }],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Cancel me' });
    const meta = orchestrator.dispatch(task.meta.id, 'fake');

    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'awaiting-approval'
    );
    await orchestrator.cancel(meta.id);

    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('cancelled');
    // M2: task status is deliberately left alone (a cancelled run says
    // nothing about whether the task itself should move), but the
    // cancellation is still recorded as a durable Activity line.
    expect(store.get(task.meta.id)!.meta.status).toBe('in-progress');
    expect(store.get(task.meta.id)!.body).toContain(
      `[run ${meta.id}] cancelled`
    );
  });
});

describe('Orchestrator.sendMessage resume (request-changes)', () => {
  it('re-dispatches into the same worktree/branch after a finished run', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished', sessionId: 'sess-1' } })
    );
    const task = store.create({ title: 'Resume me' });
    const first = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(first.id)?.meta.state === 'finished'
    );

    const second = orchestrator.sendMessage(first.id, 'please fix x', {
      resume: true,
    });

    expect(second.id).not.toBe(first.id);
    expect(second.branch).toBe(first.branch);
    expect(second.worktreePath).toBe(first.worktreePath);

    // Like the no-approval script in the full-lifecycle test, this second
    // run can finish synchronously before `sendMessage` even returns, so
    // assert on the settled end state rather than an intermediate one.
    await waitFor(
      () => orchestrator.getRun(second.id)?.meta.state === 'finished'
    );
    expect(store.get(task.meta.id)!.meta.status).toBe('in-review');
    expect(store.get(task.meta.id)!.body).toContain(
      `requested changes (run ${second.id}): please fix x`
    );
  });
});

describe('Orchestrator.review merge', () => {
  it('squash-merges the branch into base, closes the task, and removes the worktree', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'merged.txt'), 'merged content\n');
            },
            commitMessage: 'agent: add merged.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Merge me' });
    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    orchestrator.review(meta.id, 'merge');

    expect(existsSync(join(repo, 'merged.txt'))).toBe(true);
    const log = runGitSync(repo, ['log', '-1', '--pretty=%s']).trim();
    expect(log).toBe(`dispatch: Merge me (run ${meta.id})`);
    expect(store.get(task.meta.id)!.meta.status).toBe('done');
    expect(existsSync(meta.worktreePath)).toBe(false);
  });

  it('refuses with a conflict error when the main checkout is dirty', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'Dirty main' });
    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    writeFileSync(join(repo, 'uncommitted.txt'), 'oops\n');

    expect(() => orchestrator.review(meta.id, 'merge')).toThrow(
      OrchestratorConflictError
    );
    expect(store.get(task.meta.id)!.meta.status).not.toBe('done');
  });

  // Residual of Important #5 (fix-wave verification New-1): `git commit`
  // inside mergeSquash commits the whole index, so anything the user STAGED
  // before merging — including `.dispatch/` paths the dirty gate admits —
  // would silently ride into the squash commit. The merge must refuse.
  it('refuses when the main checkout index has staged changes, even under .dispatch/', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'Staged index' });
    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    writeFileSync(join(repo, '.dispatch', 'config.yml'), 'autoCommit: true\n');
    runGitSync(repo, ['add', '.dispatch/config.yml']);

    expect(() => orchestrator.review(meta.id, 'merge')).toThrow(
      /staged changes/
    );
    expect(store.get(task.meta.id)!.meta.status).not.toBe('done');
    // The staged edit is still staged, untouched by the refused merge.
    const staged = runGitSync(repo, ['diff', '--cached', '--name-only']);
    expect(staged.trim()).toBe('.dispatch/config.yml');
  });
});

// C1/C4: the merge path's new ordering — verify the checkout is actually on
// `baseBranch` first, run the squash-merge before any task bookkeeping (so a
// failed merge never leaves a task marked done for work that never landed),
// recover the main checkout on a git failure instead of leaving it mid-merge,
// and stage only the run's own task file rather than the whole `.dispatch/`
// directory when folding bookkeeping into the squash commit.
describe('Orchestrator.review merge ordering and failure handling', () => {
  it('C4: refuses with a conflict error when main is checked out on a different branch, leaving everything untouched', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'feature.txt'), 'hi\n');
            },
            commitMessage: 'agent: add feature.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Wrong branch checked out' });
    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );
    expect(meta.baseBranch).toBe('main');

    runGitSync(repo, ['checkout', '-b', 'some-other-branch']);

    expect(() => orchestrator.review(meta.id, 'merge')).toThrow(
      OrchestratorConflictError
    );
    try {
      orchestrator.review(meta.id, 'merge');
    } catch (err) {
      expect((err as Error).message).toBe(
        'merge target is some-other-branch, expected main'
      );
    }

    // Nothing about the run or the task moved: the branch/worktree are
    // still there to retry against once the user checks main back out.
    expect(store.get(task.meta.id)!.meta.status).not.toBe('done');
    expect(existsSync(meta.worktreePath)).toBe(true);
    expect(runGitSync(repo, ['branch', '--list', meta.branch])).toContain(
      meta.branch
    );
  });

  it('B: recovers from a real squash-merge conflict with a 409, leaving the task status untouched and main clean for a retry', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'shared.txt'), 'agent version\n');
            },
            commitMessage: 'agent: edit shared.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Conflicting merge' });
    // Both main and the run's branch will edit the same file, from the same
    // starting point, guaranteeing a real content conflict on squash-merge.
    writeFileSync(join(repo, 'shared.txt'), 'original\n');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'add shared.txt']);

    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    // Main moves on with an incompatible edit to the same file after the
    // run's branch diverged.
    writeFileSync(join(repo, 'shared.txt'), 'human version\n');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'human edits shared.txt']);

    // New-2: git reports content conflicts on stdout, so the 409's message
    // must actually name the conflicting file, not trail off empty.
    expect(() => orchestrator.review(meta.id, 'merge')).toThrow(/shared\.txt/);

    // Task status must not have moved to done for a merge that never
    // actually happened.
    expect(store.get(task.meta.id)!.meta.status).not.toBe('done');
    // Main must be back to a clean, mergeable state (git reset --merge),
    // not stuck mid-conflict — a retry after manual resolution must be
    // possible.
    expect(runGitSync(repo, ['status', '--porcelain']).trim()).toBe('');
    expect(existsSync(join(repo, 'shared.txt'))).toBe(true);

    // Retry after resolving manually: bring the run's own change in by
    // hand, then merge/discard cleanly resolves the run.
    orchestrator.review(meta.id, 'discard');
    expect(store.get(task.meta.id)!.meta.status).toBe('todo');
  });

  it("C: keeps a user's own unrelated .dispatch/config.yml edit out of the squash commit", async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'feature.txt'), 'hi\n');
            },
            commitMessage: 'agent: add feature.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Unrelated config edit' });
    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    // The user's own pending edit, unrelated to this run. isMainDirtyOutsideDispatch
    // deliberately excludes `.dispatch/` so this never blocks the merge —
    // but it must also never get swept into the squash commit.
    mkdirSync(join(repo, '.dispatch'), { recursive: true });
    writeFileSync(
      join(repo, '.dispatch', 'config.yml'),
      'statuses: [todo, done]\nautoCommit: false\n# user was mid-edit\n'
    );

    orchestrator.review(meta.id, 'merge');

    const committedFiles = runGitSync(repo, [
      'show',
      '--name-only',
      '--pretty=format:',
      'HEAD',
    ])
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(committedFiles).not.toContain('.dispatch/config.yml');
    // Still sitting there uncommitted, exactly as the user left it.
    expect(
      runGitSync(repo, [
        'status',
        '--porcelain',
        '--',
        '.dispatch/config.yml',
      ]).trim()
    ).not.toBe('');
  });

  it('H: back-to-back merges of two different runs both succeed', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'first.txt'), 'first\n');
            },
            commitMessage: 'agent: add first.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    orchestrator.registerExecutor(
      'fake2',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'second.txt'), 'second\n');
            },
            commitMessage: 'agent: add second.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const taskA = store.create({ title: 'First run to merge' });
    const taskB = store.create({ title: 'Second run to merge' });
    const metaA = orchestrator.dispatch(taskA.meta.id, 'fake');
    const metaB = orchestrator.dispatch(taskB.meta.id, 'fake2');
    await waitFor(
      () =>
        orchestrator.getRun(metaA.id)?.meta.state === 'finished' &&
        orchestrator.getRun(metaB.id)?.meta.state === 'finished'
    );

    expect(() => orchestrator.review(metaA.id, 'merge')).not.toThrow();
    expect(() => orchestrator.review(metaB.id, 'merge')).not.toThrow();

    expect(existsSync(join(repo, 'first.txt'))).toBe(true);
    expect(existsSync(join(repo, 'second.txt'))).toBe(true);
    expect(store.get(taskA.meta.id)!.meta.status).toBe('done');
    expect(store.get(taskB.meta.id)!.meta.status).toBe('done');
  });

  it('I: merges successfully with tracked task files and a mainline commit landed since the branch point', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'feature.txt'), 'hi\n');
            },
            commitMessage: 'agent: add feature.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Tracked task file' });
    // Commit the task file (and its own dispatched-Activity edit) so it's
    // tracked in git, matching real project usage where `.dispatch/tasks`
    // is committed alongside code.
    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'track dispatched task']);
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    // The base branch moves on with an unrelated mainline commit after the
    // run's branch diverged.
    writeFileSync(join(repo, 'unrelated.txt'), 'unrelated change\n');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'unrelated mainline commit']);

    expect(() => orchestrator.review(meta.id, 'merge')).not.toThrow();
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true);
    expect(existsSync(join(repo, 'unrelated.txt'))).toBe(true);
    expect(store.get(task.meta.id)!.meta.status).toBe('done');
  });

  // Regression guard for the "squash first" reordering: a run that made no
  // file changes at all (a chatty run — nothing for `git merge --squash` to
  // squash) must still merge successfully. The task-file bookkeeping commit
  // is the only commit in that case, since there's no squash commit to fold
  // it into.
  it('merges successfully even when the run made no file changes to squash', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'No-op run' });
    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    expect(() => orchestrator.review(meta.id, 'merge')).not.toThrow();
    expect(store.get(task.meta.id)!.meta.status).toBe('done');
    const log = runGitSync(repo, ['log', '-1', '--pretty=%s']).trim();
    expect(log).toBe(`dispatch: No-op run (run ${meta.id})`);
  });
});

describe('Orchestrator.review discard', () => {
  it('removes the worktree/branch and restores the task to todo', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'Discard me' });
    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    orchestrator.review(meta.id, 'discard');

    expect(existsSync(meta.worktreePath)).toBe(false);
    expect(store.get(task.meta.id)!.meta.status).toBe('todo');
  });
});

// C2: review() must require a terminal state (a run still awaiting
// approval/running has nothing to review yet) and must refuse a run that has
// already been reviewed once — merge/discard is a one-way door per run.
describe('Orchestrator review-state guard', () => {
  it('A: refuses to discard a run that is still awaiting approval', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [{ approval: { requestId: 'hold', toolName: 't', input: {} } }],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Not terminal yet' });
    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'awaiting-approval'
    );

    expect(() => orchestrator.review(meta.id, 'discard')).toThrow(
      OrchestratorConflictError
    );
    // Nothing was torn down — the run is still there, still awaiting its
    // approval.
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('awaiting-approval');
    expect(existsSync(meta.worktreePath)).toBe(true);
  });

  it('E: refuses a second review call on an already-reviewed run (double merge)', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'double.txt'), 'once\n');
            },
            commitMessage: 'agent: add double.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Double merge' });
    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    orchestrator.review(meta.id, 'merge');

    expect(() => orchestrator.review(meta.id, 'merge')).toThrow(
      OrchestratorConflictError
    );
    expect(() => orchestrator.review(meta.id, 'discard')).toThrow(
      OrchestratorConflictError
    );
  });

  it('E: refuses request-changes/resume on an already-reviewed run', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished', sessionId: 's-1' } })
    );
    const task = store.create({ title: 'Resume after review' });
    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    orchestrator.review(meta.id, 'discard');

    expect(() =>
      orchestrator.sendMessage(meta.id, 'please fix x', { resume: true })
    ).toThrow(OrchestratorConflictError);
  });

  it('records reviewedAt/reviewAction on the run meta once reviewed', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'Records review marker' });
    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    orchestrator.review(meta.id, 'discard');

    const reviewed = orchestrator.getRun(meta.id)!.meta;
    expect(reviewed.reviewAction).toBe('discard');
    expect(typeof reviewed.reviewedAt).toBe('string');
  });
});

// I4: once a run has an open PR (PrManager.openPr has pushed the branch and
// created it — recorded here via setRunPrUrl, the same call it makes), the
// *local* review/resume actions must refuse rather than race the PR: a local
// merge/discard would tear down the worktree/branch out from under an
// in-flight remote review, and resuming would keep writing to a branch
// someone else may already be reviewing on GitHub.
describe('Orchestrator PR guards', () => {
  async function dispatchToFinished(
    orchestrator: ReturnType<typeof makeOrchestrator>['orchestrator'],
    store: ReturnType<typeof makeOrchestrator>['store']
  ): Promise<RunMeta> {
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished', sessionId: 's-1' } })
    );
    const task = store.create({ title: 'Has an open PR' });
    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );
    return meta;
  }

  it('409s review(merge) once a run has an open PR', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const meta = await dispatchToFinished(orchestrator, store);
    orchestrator.setRunPrUrl(meta.id, 'https://github.com/example/repo/pull/1');

    expect(() => orchestrator.review(meta.id, 'merge')).toThrow(
      OrchestratorConflictError
    );
    expect(() => orchestrator.review(meta.id, 'merge')).toThrow(/open PR/);
  });

  it('409s review(discard) once a run has an open PR', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const meta = await dispatchToFinished(orchestrator, store);
    orchestrator.setRunPrUrl(meta.id, 'https://github.com/example/repo/pull/1');

    expect(() => orchestrator.review(meta.id, 'discard')).toThrow(
      OrchestratorConflictError
    );
  });

  it('409s sendMessage(resume: true) once a run has an open PR', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const meta = await dispatchToFinished(orchestrator, store);
    orchestrator.setRunPrUrl(meta.id, 'https://github.com/example/repo/pull/1');

    expect(() =>
      orchestrator.sendMessage(meta.id, 'please fix x', { resume: true })
    ).toThrow(OrchestratorConflictError);
  });
});

// C2(b): a subscriber's own bug must never change the outcome of the
// operation that triggered it — handleFinish/cancel/review/
// markRunMergedViaPr all fire hooks as their very last step specifically so
// a poisoned hook can't have altered anything about the run/task by then,
// but the hook-invocation loop itself must also isolate a throwing
// subscriber from every other subscriber and from the caller.
describe('Orchestrator hook isolation', () => {
  it('a poisoned onRunTerminal subscriber does not affect handleFinish', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    orchestrator.onRunTerminal(() => {
      throw new Error('boom terminal hook');
    });
    const task = store.create({ title: 'Poisoned terminal hook' });
    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );
    // handleFinish's own outcome (task -> in-review) must have landed
    // despite the subscriber throwing, and the failure gets logged rather
    // than silently swallowed.
    expect(store.get(task.meta.id)?.meta.status).toBe('in-review');
    expect(store.get(task.meta.id)?.body).toContain('[hook error]');
  });

  it('a poisoned onRunReviewed subscriber does not affect review(merge)', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    orchestrator.onRunReviewed(() => {
      throw new Error('boom reviewed hook');
    });
    const task = store.create({ title: 'Poisoned reviewed hook' });
    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    const reviewed = orchestrator.review(meta.id, 'merge');

    expect(reviewed.reviewedAt).toBeDefined();
    expect(store.get(task.meta.id)?.meta.status).toBe('done');
    expect(store.get(task.meta.id)?.body).toContain('[hook error]');
  });
});

// Important #7: a reviewed run has no worktree left to diff at all — the
// endpoint must answer with a clean 409, not let a git command run against a
// removed cwd and blow up as an internal error.
describe('Orchestrator.diff on a reviewed run', () => {
  it('409s instead of erroring once the run has been reviewed and its worktree removed', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'Diff after review' });
    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    orchestrator.review(meta.id, 'discard');

    expect(() => orchestrator.diff(meta.id)).toThrow(OrchestratorConflictError);
  });
});

describe('Orchestrator.diff', () => {
  it('returns a real patch and file list for a run with committed changes', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'diffed.txt'), 'diff content\n');
            },
            commitMessage: 'agent: add diffed.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Diff me' });
    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    const result = orchestrator.diff(meta.id);
    expect(result.patch).toContain('diffed.txt');
    expect(result.files).toEqual([{ path: 'diffed.txt', status: 'A' }]);
  });
});

describe('Orchestrator concurrency', () => {
  it('rejects a second dispatch for the same task with a conflict error', () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [{ approval: { requestId: 'hold', toolName: 't', input: {} } }],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Only one live run' });
    orchestrator.dispatch(task.meta.id, 'fake');

    expect(() => orchestrator.dispatch(task.meta.id, 'fake')).toThrow(
      OrchestratorConflictError
    );
  });

  it('404s dispatching an unknown task', () => {
    const { orchestrator } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    expect(() => orchestrator.dispatch('t-000000', 'fake')).toThrow(
      OrchestratorNotFoundError
    );
  });

  it('rejects dispatch to an unregistered executor', () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const task = store.create({ title: 'No such executor' });
    expect(() => orchestrator.dispatch(task.meta.id, 'claude')).toThrow(
      OrchestratorClientError
    );
  });

  it('runs two dispatches for different tasks concurrently without interference', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'a.txt'), 'from a\n');
            },
            commitMessage: 'agent: add a.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    orchestrator.registerExecutor(
      'fake2',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'b.txt'), 'from b\n');
            },
            commitMessage: 'agent: add b.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const taskA = store.create({ title: 'Task A' });
    const taskB = store.create({ title: 'Task B' });

    const metaA = orchestrator.dispatch(taskA.meta.id, 'fake');
    const metaB = orchestrator.dispatch(taskB.meta.id, 'fake2');

    await waitFor(
      () =>
        orchestrator.getRun(metaA.id)?.meta.state === 'finished' &&
        orchestrator.getRun(metaB.id)?.meta.state === 'finished'
    );

    expect(existsSync(join(metaA.worktreePath, 'a.txt'))).toBe(true);
    expect(existsSync(join(metaB.worktreePath, 'b.txt'))).toBe(true);
    expect(existsSync(join(metaA.worktreePath, 'b.txt'))).toBe(false);
    expect(existsSync(join(metaB.worktreePath, 'a.txt'))).toBe(false);
  });
});

describe('Orchestrator.reconcileOnBoot', () => {
  it('marks interrupted runs failed and prunes orphan worktree directories', async () => {
    const { orchestrator: first, store } = makeOrchestrator(repo);
    first.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [{ approval: { requestId: 'stuck', toolName: 't', input: {} } }],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Interrupted by crash' });
    const meta = first.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => first.getRun(meta.id)?.meta.state === 'awaiting-approval'
    );

    // Simulate a leftover directory under the worktrees root that has no
    // matching transcript at all (e.g. a crash between mkdir and the
    // transcript header write).
    const orphanPath = join(worktreesDir(repo), 'orphan-no-transcript');
    mkdirSync(orphanPath, { recursive: true });

    // Simulate a process restart: build a fresh Orchestrator (empty
    // in-memory registry) against the same rootDir/DISPATCH_HOME and
    // reconcile.
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

    expect(second.getRun(meta.id)?.meta.state).toBe('failed');
    expect(existsSync(meta.worktreePath)).toBe(true);
    expect(existsSync(orphanPath)).toBe(false);
  });

  // C3: a transcript truncated by a crash mid-write (header parses, but the
  // line after it is corrupt JSON) must not abort reconciliation for every
  // other run — the corrupt line is skipped (transcript.ts's tolerant
  // read()) and the run still gets marked failed off of its header state.
  it('boots and marks a run failed even when its transcript has a truncated line', () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const task = store.create({ title: 'Truncated transcript' });
    const runId = 'r-abcdef';
    const meta: RunMeta = {
      id: runId,
      taskId: task.meta.id,
      taskTitle: task.meta.title,
      executor: 'fake',
      state: 'running',
      branch: 'dispatch/truncated',
      baseBranch: 'main',
      worktreePath: join(worktreesDir(repo), runId),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(meta.worktreePath, { recursive: true });
    const path = transcriptPath(repo, runId);
    new Transcript(path).writeHeader(meta);
    // A crash mid-write: a truncated, unparsable JSON fragment appended
    // straight to the file (bypassing Transcript's own append methods,
    // which always write a complete line).
    appendFileSync(path, '{"type":"state","state":"fini\n');

    expect(() => orchestrator.reconcileOnBoot()).not.toThrow();

    expect(orchestrator.getRun(runId)?.meta.state).toBe('failed');
  });

  // C3 (broader case): a transcript "file" that fails outright to read
  // (not just to JSON-parse — e.g. a directory sitting where a `.jsonl` file
  // is expected, which throws EISDIR on readFileSync) must not abort
  // reconciliation for every *other* run's transcript. One bad entry is
  // skipped; the rest of the runs directory still gets processed.
  it('skips a transcript entry that fails to read entirely, without losing other runs', () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const task = store.create({ title: 'Reconciled alongside a bad entry' });
    const runId = 'r-fedcba';
    const meta: RunMeta = {
      id: runId,
      taskId: task.meta.id,
      taskTitle: task.meta.title,
      executor: 'fake',
      state: 'running',
      branch: 'dispatch/reconciled',
      baseBranch: 'main',
      worktreePath: join(worktreesDir(repo), runId),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(meta.worktreePath, { recursive: true });
    new Transcript(transcriptPath(repo, runId)).writeHeader(meta);

    // A directory where a transcript file is expected: existsSync() is
    // true, but readFileSync() throws EISDIR rather than returning text —
    // a failure mode the JSON.parse try/catch inside Transcript.read()
    // can't reach at all.
    mkdirSync(join(runsDir(repo), 'r-000bad.jsonl'), { recursive: true });

    expect(() => orchestrator.reconcileOnBoot()).not.toThrow();

    expect(orchestrator.getRun(runId)?.meta.state).toBe('failed');
  });
});

describe('Orchestrator onFinish safety net (uncommitted changes)', () => {
  it('auto-commits a dirty worktree left uncommitted by the executor', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'forgot-to-commit.txt'), 'oops\n');
            },
            // Leaves the write uncommitted, simulating an executor that
            // "forgets" to commit before finishing — exactly what the
            // orchestrator's onFinish safety net exists to catch.
            commit: false,
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Executor forgets to commit' });

    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    expect(
      runGitSync(meta.worktreePath, ['status', '--porcelain']).trim()
    ).toBe('');
    const log = runGitSync(meta.worktreePath, ['log', '-1', '--pretty=%s']);
    expect(log.trim()).toBe(
      `wip(dispatch): uncommitted changes from run ${meta.id}`
    );
  });

  it('is a no-op when the worktree is already clean', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'committed.txt'), 'fine\n');
            },
            commitMessage: 'agent: add committed.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Executor commits its own work' });

    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    const log = runGitSync(meta.worktreePath, ['log', '-1', '--pretty=%s']);
    expect(log.trim()).toBe('agent: add committed.txt');
  });

  // I6: handleFinish's own git work (autoCommitIfDirty) must never let an
  // escaped throw reach the caller — an executor's onFinish is invoked from
  // deep inside its own event plumbing, and an uncaught exception there has
  // nowhere useful to go, leaving the run stuck in whatever state it was in
  // (a zombie: neither cleanly finished nor visibly failed). A worktree that
  // has been deleted out from under a run before it finishes (e.g. an
  // operator cleanup, a crash-adjacent race) must instead surface as a
  // normal `failed` run.
  it('marks a run failed instead of throwing when its worktree is gone by the time it finishes', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [{ approval: { requestId: 'hold', toolName: 't', input: {} } }],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Worktree deleted mid-run' });
    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'awaiting-approval'
    );

    rmSync(meta.worktreePath, { recursive: true, force: true });

    expect(() => orchestrator.approve(meta.id, 'hold', true)).not.toThrow();
    await waitFor(() => orchestrator.getRun(meta.id)?.meta.state === 'failed');
    expect(orchestrator.getRun(meta.id)?.meta.error).toBeDefined();
  });
});

describe('Orchestrator per-run caps and prompt assembly', () => {
  // A minimal Executor that just records the options it was started with
  // and finishes immediately — used to assert on exactly what the
  // orchestrator hands an executor, independent of FakeExecutor's own
  // scripting concerns.
  class CapturingExecutor implements Executor {
    lastOpts?: ExecutorStartOptions;

    start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
      this.lastOpts = opts;
      events.onFinish({ state: 'finished' });
      return {
        interrupt: () => Promise.resolve(),
        send: () => {},
        approve: () => {},
      };
    }
  }

  it('passes the configured orchestrator caps through to the executor', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    mkdirSync(join(repo, '.dispatch'), { recursive: true });
    writeFileSync(
      join(repo, '.dispatch/config.yml'),
      'orchestrator:\n  maxTurns: 7\n  maxBudgetUsd: 2.5\n  permissionMode: plan\n'
    );
    const executor = new CapturingExecutor();
    orchestrator.registerExecutor('fake', executor);
    const task = store.create({ title: 'Respect config caps' });

    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    expect(executor.lastOpts?.maxTurns).toBe(7);
    expect(executor.lastOpts?.maxBudgetUsd).toBe(2.5);
    expect(executor.lastOpts?.permissionMode).toBe('plan');
  });

  it('falls back to 100 turns / acceptEdits with no config file', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const executor = new CapturingExecutor();
    orchestrator.registerExecutor('fake', executor);
    const task = store.create({ title: 'Default caps' });

    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    expect(executor.lastOpts?.maxTurns).toBe(100);
    expect(executor.lastOpts?.maxBudgetUsd).toBeUndefined();
    expect(executor.lastOpts?.permissionMode).toBe('acceptEdits');
  });

  it('builds a prompt that includes the parent epic when the task has one', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const executor = new CapturingExecutor();
    orchestrator.registerExecutor('fake', executor);
    const epic = store.create({
      title: 'Harden auth',
      kind: 'epic',
      description: 'Make the auth system resistant to abuse.',
    });
    const task = store.create({
      title: 'Add login rate limiting',
      parent: epic.meta.id,
    });

    const meta = orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    expect(executor.lastOpts?.prompt).toContain('Add login rate limiting');
    expect(executor.lastOpts?.prompt).toContain('Harden auth');
    expect(executor.lastOpts?.prompt).toContain('resistant to abuse');
  });
});
