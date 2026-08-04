import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { transcriptPath } from '../../src/orchestrator/paths.js';
import { replayTranscript } from '../../src/orchestrator/transcript.js';
import type {
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
} from '../../src/orchestrator/types.js';
import { OrchestratorConflictError } from '../../src/orchestrator/types.js';
import { initGitRepo } from './helpers.js';

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

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

function makeOrchestrator(
  rootDir: string,
  opts: { stopEscalationMs?: number } = {}
): { orchestrator: Orchestrator; store: TaskStore } {
  const store = TaskStore.init(rootDir);
  const cache = new TaskCache();
  cache.rebuild(store);
  const orchestrator = new Orchestrator({
    rootDir,
    store,
    cache,
    events: new EventBus(),
    ...opts,
  });
  return { orchestrator, store };
}

/**
 * A two-step script whose FIRST step is slow and whose SECOND step writes a
 * file no graceful stop should ever allow.
 *
 * The delay sits at the head of step one, before its own write, so a stop
 * requested during that window lands squarely mid-step: `first.txt` existing
 * afterwards is the proof that the operation already underway was allowed to
 * finish, and `second.txt` never existing is the proof that nothing new began.
 */
function twoStepScript(): FakeExecutor {
  return new FakeExecutor({
    steps: [
      {
        delayMs: 200,
        write: (cwd) => {
          writeFileSync(join(cwd, 'first.txt'), 'in-flight work\n');
        },
        commitMessage: 'agent: first step',
      },
      {
        write: (cwd) => {
          writeFileSync(join(cwd, 'second.txt'), 'work that never started\n');
        },
        commitMessage: 'agent: second step',
      },
    ],
    finish: { state: 'finished', costUsd: 0.5, turns: 2 },
  });
}

describe('Orchestrator.requestStop', () => {
  it('lets the in-flight operation finish, starts nothing new, and finishes normally', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor('fake', twoStepScript());
    const task = store.create({ title: 'Long job' });

    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    const stopped = orchestrator.requestStop(meta.id);
    expect(stopped.stopRequestedAt).toBeDefined();
    // Still live: a graceful stop is a request, not a state change.
    expect(stopped.state).not.toBe('cancelled');

    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    // The step already running when Stop was pressed ran to completion...
    expect(existsSync(join(meta.worktreePath, 'first.txt'))).toBe(true);
    // ...and the one that had not started never did.
    expect(existsSync(join(meta.worktreePath, 'second.txt'))).toBe(false);

    const after = orchestrator.getRun(meta.id)!.meta;
    // The whole point of stopping rather than cancelling: the run reaches its
    // own terminal state through handleFinish, so it is reviewable like any
    // other finished run, and it still carries the marker saying why it ended.
    expect(after.state).toBe('finished');
    expect(after.stopRequestedAt).toBeDefined();
    expect(store.get(task.meta.id)!.meta.status).toBe('in-review');
  });

  it('commits work the agent left uncommitted when it wound down', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            delayMs: 200,
            write: (cwd) => {
              writeFileSync(join(cwd, 'loose.txt'), 'never committed\n');
            },
            // The executor "forgets" to commit, which is exactly the case
            // handleFinish's auto-commit safety net exists for — and exactly
            // what cancel() deliberately skips.
            commit: false,
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Uncommitted work' });

    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    orchestrator.requestStop(meta.id);
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    // Committed, not merely present on disk: only committed content survives
    // the squash-merge a review performs.
    const diff = orchestrator.diff(meta.id);
    expect(diff.files.map((f) => f.path)).toContain('loose.txt');
  });

  it('unblocks a run parked at an approval gate without failing it', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [{ approval: { requestId: 'go', toolName: 'Bash', input: {} } }],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Waiting on a human' });

    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'awaiting-approval'
    );

    orchestrator.requestStop(meta.id);

    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );
    // Not 'failed': the synthetic denial that unblocks the gate is the stop
    // talking, not a human refusing a tool.
    expect(orchestrator.getRun(meta.id)!.meta.error).toBeUndefined();
  });

  it('records the stop on the transcript and the task Activity, and survives a replay', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor('fake', twoStepScript());
    const task = store.create({ title: 'Traceable stop' });

    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    orchestrator.requestStop(meta.id);
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    expect(store.get(task.meta.id)!.body).toContain(
      `[run ${meta.id}] stop requested`
    );

    // Replay is what a daemon restart sees: the marker has to be in the file,
    // not only in the in-memory registry.
    const replayed = replayTranscript(transcriptPath(repo, meta.id))!;
    expect(replayed.meta.stopRequestedAt).toBeDefined();
    expect(replayed.meta.state).toBe('finished');
    expect(
      replayed.entries.some((e) => e.text?.includes('Stop requested') === true)
    ).toBe(true);
  });

  it('is idempotent, and refuses a run that has already finished', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor('fake', twoStepScript());
    const task = store.create({ title: 'Double stop' });

    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    const first = orchestrator.requestStop(meta.id);
    const second = orchestrator.requestStop(meta.id);
    // A second press re-signals the executor but must not restart the clock or
    // rewrite when the human actually asked.
    expect(second.stopRequestedAt).toBe(first.stopRequestedAt);

    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );
    expect(() => orchestrator.requestStop(meta.id)).toThrow(
      OrchestratorConflictError
    );
  });
});

/**
 * An executor that hears the stop and keeps going — the case the escalation
 * timer exists for. It never finishes on its own, so the only way its run can
 * reach a terminal state is the escalation falling back to a hard cancel.
 */
class DeafExecutor implements Executor {
  start(_opts: ExecutorStartOptions, _events: ExecutorEvents): ExecutorRun {
    return {
      interrupt: () => Promise.resolve(),
      requestStop: () => {},
      send: () => {},
      approve: () => {},
    };
  }
}

describe('Orchestrator stop escalation', () => {
  it('falls back to a hard cancel when the agent never winds down', async () => {
    const { orchestrator, store } = makeOrchestrator(repo, {
      stopEscalationMs: 50,
    });
    orchestrator.registerExecutor('deaf', new DeafExecutor());
    const task = store.create({ title: 'Stubborn agent' });

    const meta = await orchestrator.dispatch(task.meta.id, 'deaf');
    orchestrator.requestStop(meta.id);

    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'cancelled'
    );
    expect(store.get(task.meta.id)!.body).toContain('escalating to cancel');
  });

  // The window is deliberately longer than the script's own in-flight step:
  // an agent that takes a moment to wind down is the NORMAL case, and a stop
  // that quietly turned into a cancel on the way would lose the very work the
  // graceful path exists to keep.
  it('does not cancel a run that wound down before the window elapsed', async () => {
    const { orchestrator, store } = makeOrchestrator(repo, {
      stopEscalationMs: 400,
    });
    orchestrator.registerExecutor('fake', twoStepScript());
    const task = store.create({ title: 'Prompt agent' });

    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    orchestrator.requestStop(meta.id);
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    // Waits out the rest of the window, so a timer that still fired would have
    // fired by the time this asserts.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(orchestrator.getRun(meta.id)!.meta.state).toBe('finished');
  });
});
