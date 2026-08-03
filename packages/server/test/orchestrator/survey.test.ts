import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
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
import type {
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
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

// A `pre-commit` hook that always refuses, installed in the main repo's
// shared hooks dir — makes the auto-commit safety net a no-op in a worktree.
function installRejectingPreCommitHook(repoDir: string): void {
  const hooksDir = join(repoDir, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'pre-commit');
  writeFileSync(hookPath, '#!/bin/sh\nexit 1\n');
  chmodSync(hookPath, 0o755);
}

// Starts and just sits there — never calls onFinish on its own — so a
// dispatched run stays 'running' until something else (a reboot) acts on it.
function controllableExecutor(): Executor {
  return {
    start(): ExecutorRun {
      return {
        interrupt: () => Promise.resolve(),
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
    installRejectingPreCommitHook(repo);
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
    expect(run.meta.error).toBe('connection dropped');
    expect(run.meta.survey?.cleanTree).toBe(false);
    // autoCommitIfDirty's `git add -A` still ran (only the doomed `commit`
    // failed), so the file shows up staged rather than untracked.
    expect(run.meta.survey?.staged).toEqual(['oops.txt']);
    expect(store.get(task.meta.id)!.meta.status).toBe('in-review');
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
    installRejectingPreCommitHook(repo);
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
