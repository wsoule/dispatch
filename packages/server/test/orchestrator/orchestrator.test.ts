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
import { worktreesDir } from '../../src/orchestrator/paths.js';
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
    expect(store.get(task.meta.id)!.meta.status).toBe('in-progress');
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
});
