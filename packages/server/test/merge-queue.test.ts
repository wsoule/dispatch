import { DISPATCH_DIR, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { EventBus } from '../src/events.js';
import type { ServerEvent } from '../src/events.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import { JjManager } from '../src/orchestrator/jj.js';
import { MergeQueue } from '../src/orchestrator/mergeQueue.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import {
  mergeQueuePath,
  runsDir,
  transcriptPath,
} from '../src/orchestrator/paths.js';
import type { CommandResult, CommandRunner } from '../src/orchestrator/pr.js';
import { defaultCommandRunner } from '../src/orchestrator/pr.js';
import { replayTranscript } from '../src/orchestrator/transcript.js';
import type { RunMeta } from '../src/orchestrator/types.js';
import {
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from '../src/orchestrator/types.js';
import { initGitRepo, runGitSync } from './orchestrator/helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-merge-queue-');
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

// Records every command it was asked to run and answers with fixed,
// scriptable results per command shape — mirrors pr.test.ts's StubRunner,
// scoped to exactly the git/gh invocations the merge queue makes.
class StubRunner {
  readonly calls: { cwd: string; cmd: string[] }[] = [];
  rebaseResult: CommandResult = { ok: true, stdout: '', stderr: '' };
  fetchResult: CommandResult = { ok: true, stdout: '', stderr: '' };
  verifyResult: CommandResult = { ok: true, stdout: '', stderr: '' };
  pushResult: CommandResult = { ok: true, stdout: '', stderr: '' };
  ghMergeResult: CommandResult = { ok: true, stdout: '', stderr: '' };

  run = async (cwd: string, cmd: string[]): Promise<CommandResult> => {
    this.calls.push({ cwd, cmd });
    if (cmd[0] === 'git' && cmd[1] === 'fetch') return this.fetchResult;
    if (cmd[0] === 'git' && cmd[1] === 'rebase' && cmd[2] === '--abort') {
      return { ok: true, stdout: '', stderr: '' };
    }
    if (cmd[0] === 'git' && cmd[1] === 'rebase') return this.rebaseResult;
    if (cmd[0] === 'bash' && cmd[1] === '-lc') return this.verifyResult;
    if (cmd[0] === 'git' && cmd[1] === 'push') return this.pushResult;
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'merge') {
      return this.ghMergeResult;
    }
    return { ok: false, stdout: '', stderr: 'unhandled stub command' };
  };
}

interface Harness {
  rootDir: string;
  orchestrator: Orchestrator;
  store: TaskStore;
  cache: TaskCache;
  events: EventBus;
}

// `jj` is passed to the Orchestrator only — the returned Harness deliberately
// does not carry it, so a MergeQueue built over this harness still picks its
// own jj path from the CommandRunner each test injects.
function makeHarness(jj?: JjManager): Harness {
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
    new FakeExecutor({ finish: { state: 'finished', costUsd: 0, turns: 1 } })
  );
  return { rootDir: repo, orchestrator, store, cache, events };
}

async function dispatchAndFinish(
  harness: Harness,
  title = 'Ship it'
): Promise<{ runId: string; taskId: string }> {
  const task = harness.store.create({ title });
  const meta = await harness.orchestrator.dispatch(task.meta.id, 'fake');
  await waitFor(
    () => harness.orchestrator.getRun(meta.id)?.meta.state === 'finished'
  );
  return { runId: meta.id, taskId: task.meta.id };
}

// Captures every broadcast event so tests can assert `merge-queue.changed`
// was actually sent, mirroring how other tests observe EventBus output — a
// plain object satisfying the BroadcastClient interface (`send`).
function captureEvents(events: EventBus): ServerEvent[] {
  const seen: ServerEvent[] = [];
  events.add({
    send: (data: string) => {
      seen.push(JSON.parse(data) as ServerEvent);
    },
  });
  return seen;
}

// Makes one real commit inside a run's worktree. The restack tests need
// branches that actually carry content — an empty branch can be "rebased"
// by anything, including a no-op, so it would never discriminate.
function commitFile(worktreePath: string, name: string, message: string): void {
  writeFileSync(join(worktreePath, name), `${message}\n`);
  runGitSync(worktreePath, ['add', name]);
  runGitSync(worktreePath, ['commit', '-m', message]);
}

// Builds the stacked shape a dispatch produces once a blocker is only
// `in-review`: task A finishes with an unmerged run, so task B — blocked on A
// — is branched off A's *branch* rather than main, and records A's branch in
// `stackParents` plus the exact commit it forked from in `stackBaseCommit`.
// Each run gets its own commit so a restack has real work to replay.
async function makeStackedPair(harness: Harness): Promise<{
  blockerRun: RunMeta;
  dependentRun: RunMeta;
}> {
  const { runId: runA, taskId: taskA } = await dispatchAndFinish(
    harness,
    'Task A'
  );
  const blockerRun = harness.orchestrator.list().find((r) => r.id === runA)!;
  commitFile(blockerRun.worktreePath, 'a.txt', 'A work');

  const taskB = harness.store.create({ title: 'Task B', blockedBy: [taskA] });
  const metaB = await harness.orchestrator.dispatch(taskB.meta.id, 'fake');
  await waitFor(
    () => harness.orchestrator.getRun(metaB.id)?.meta.state === 'finished'
  );
  const dependentRun = harness.orchestrator
    .list()
    .find((r) => r.id === metaB.id)!;
  commitFile(dependentRun.worktreePath, 'b.txt', 'B work');
  return { blockerRun, dependentRun };
}

// A machine with no jj on PATH: every `jj` invocation fails exactly as a
// missing binary would, everything else really runs. This is the path every
// non-jj project takes, so it has to be exercised on its own — a passing jj
// path says nothing about it.
const noJjRunner: CommandRunner = async (cwd, cmd) =>
  cmd[0] === 'jj'
    ? { ok: false, stdout: '', stderr: 'jj: command not found' }
    : defaultCommandRunner(cwd, cmd);

// The mirror image: jj answers every invocation successfully but does
// nothing. Lets a test assert which *commands* the jj path issues (and that
// the git path was not used) without requiring a colocated jj repo.
function makeJjStubRunner(): {
  run: CommandRunner;
  jjCalls: string[][];
} {
  const jjCalls: string[][] = [];
  const run: CommandRunner = async (cwd, cmd) => {
    if (cmd[0] !== 'jj') return defaultCommandRunner(cwd, cmd);
    jjCalls.push(cmd);
    return { ok: true, stdout: '', stderr: '' };
  };
  return { run, jjCalls };
}

function writeVerifyCommand(rootDir: string, cmd: string): void {
  writeFileSync(
    join(rootDir, DISPATCH_DIR, 'config.yml'),
    `verifyCommand: "${cmd}"\n`
  );
}

describe('MergeQueue.enqueue', () => {
  it('enqueues a finished, unreviewed run as queued and broadcasts', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const seen = captureEvents(harness.events);
    const queue = new MergeQueue(harness, stub.run);

    const entry = queue.enqueue(runId);
    expect(entry.state).toBe('queued');
    expect(entry.runId).toBe(runId);

    await waitFor(
      () =>
        queue.snapshot().history.find((e) => e.runId === runId) !== undefined
    );
    expect(seen.some((e) => e.type === 'merge-queue.changed')).toBe(true);
  });

  it('404s an unknown run id', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    const queue = new MergeQueue(harness, stub.run);
    expect(() => queue.enqueue('r-000000')).toThrow(OrchestratorNotFoundError);
  });

  it('409s a run that is not in a terminal state', async () => {
    const harness = makeHarness();
    harness.orchestrator.registerExecutor(
      'stuck',
      new FakeExecutor({
        steps: [{ approval: { requestId: 'x', toolName: 'noop', input: {} } }],
        finish: { state: 'finished' },
      })
    );
    const task = harness.store.create({ title: 'Still running' });
    const meta = await harness.orchestrator.dispatch(task.meta.id, 'stuck');
    const stub = new StubRunner();
    const queue = new MergeQueue(harness, stub.run);
    expect(() => queue.enqueue(meta.id)).toThrow(OrchestratorConflictError);
  });

  it('409s a run that has already been reviewed', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    harness.orchestrator.review(runId, 'discard');
    const stub = new StubRunner();
    const queue = new MergeQueue(harness, stub.run);
    expect(() => queue.enqueue(runId)).toThrow(OrchestratorConflictError);
  });

  it('409s a duplicate enqueue of the same run', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    // Make the run's own rebase hang so the entry stays queued/active long
    // enough for the second enqueue call to observe it still present.
    stub.rebaseResult = { ok: true, stdout: '', stderr: '' };
    const queue = new MergeQueue(harness, stub.run);
    queue.enqueue(runId);
    expect(() => queue.enqueue(runId)).toThrow(OrchestratorConflictError);
  });
});

describe('MergeQueue local-run happy path', () => {
  it('rebases, skips verify (none configured), merges, and lands in history as merged', async () => {
    const harness = makeHarness();
    const { runId, taskId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const queue = new MergeQueue(harness, stub.run);

    queue.enqueue(runId);
    await waitFor(() => queue.snapshot().history.length === 1);

    const [entry] = queue.snapshot().history;
    expect(entry.state).toBe('merged');
    expect(entry.finishedAt).toBeDefined();

    const rebaseCall = stub.calls.find(
      (c) => c.cmd[0] === 'git' && c.cmd[1] === 'rebase'
    );
    expect(rebaseCall?.cmd).toEqual(['git', 'rebase', 'main']);
    // No verifyCommand configured -> no bash -lc call.
    expect(stub.calls.some((c) => c.cmd[0] === 'bash')).toBe(false);

    const task = harness.store.get(taskId);
    expect(task?.meta.status).toBe('done');
    const run = harness.orchestrator.getRun(runId);
    expect(run?.meta.reviewedAt).toBeDefined();
    expect(run?.meta.reviewAction).toBe('merge');
  });

  it('runs the configured verify command between rebase and merge', async () => {
    const harness = makeHarness();
    writeVerifyCommand(harness.rootDir, 'echo verifying');
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const queue = new MergeQueue(harness, stub.run);

    queue.enqueue(runId);
    await waitFor(() => queue.snapshot().history.length === 1);

    const verifyCall = stub.calls.find((c) => c.cmd[0] === 'bash');
    expect(verifyCall?.cmd).toEqual(['bash', '-lc', 'echo verifying']);
    // Verify must happen after rebase and before the merge review call.
    const rebaseIdx = stub.calls.findIndex((c) => c.cmd[1] === 'rebase');
    const verifyIdx = stub.calls.findIndex((c) => c.cmd[0] === 'bash');
    expect(verifyIdx).toBeGreaterThan(rebaseIdx);

    expect(queue.snapshot().history[0].state).toBe('merged');
  });

  it('fails the entry when verify fails, leaving the run unreviewed and the task not done', async () => {
    const harness = makeHarness();
    writeVerifyCommand(harness.rootDir, 'exit 1');
    const { runId, taskId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    stub.verifyResult = { ok: false, stdout: '', stderr: 'assertion failed' };
    const queue = new MergeQueue(harness, stub.run);

    queue.enqueue(runId);
    await waitFor(() => queue.snapshot().history.length === 1);

    const entry = queue.snapshot().history[0];
    expect(entry.state).toBe('failed');
    expect(entry.reason).toContain('assertion failed');

    const run = harness.orchestrator.getRun(runId);
    expect(run?.meta.reviewedAt).toBeUndefined();
    const task = harness.store.get(taskId);
    expect(task?.meta.status).not.toBe('done');
  });

  it('aborts a failed rebase, fails the entry, and still processes the next queued entry', async () => {
    const harness = makeHarness();
    const { runId: badRunId } = await dispatchAndFinish(harness, 'Bad rebase');
    const { runId: goodRunId } = await dispatchAndFinish(
      harness,
      'Good rebase'
    );
    const stub = new StubRunner();
    const queue = new MergeQueue(harness, stub.run);

    stub.rebaseResult = { ok: false, stdout: '', stderr: 'CONFLICT' };
    queue.enqueue(badRunId);
    await waitFor(() => queue.snapshot().history.length === 1);
    expect(queue.snapshot().history[0].state).toBe('failed');
    expect(queue.snapshot().history[0].reason).toContain('CONFLICT');
    const abortCall = stub.calls.find(
      (c) => c.cmd[1] === 'rebase' && c.cmd[2] === '--abort'
    );
    expect(abortCall).toBeDefined();

    stub.rebaseResult = { ok: true, stdout: '', stderr: '' };
    queue.enqueue(goodRunId);
    await waitFor(() => queue.snapshot().history.length === 2);
    const goodEntry = queue
      .snapshot()
      .history.find((e) => e.runId === goodRunId);
    expect(goodEntry?.state).toBe('merged');
  });
});

describe('MergeQueue PR-run happy path', () => {
  it('fetches, rebases onto origin, force-pushes, gh merges, and marks merged via PR', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    // Simulate an already-opened PR the same way PrManager.openPr does, so
    // process() takes the PR branch of rebase()/merge().
    harness.orchestrator.setRunPrUrl(
      runId,
      'https://github.com/example/repo/pull/1'
    );
    const stub = new StubRunner();
    const queue = new MergeQueue(harness, stub.run);

    queue.enqueue(runId);
    await waitFor(() => queue.snapshot().history.length === 1);

    expect(queue.snapshot().history[0].state).toBe('merged');
    expect(
      stub.calls.find((c) => c.cmd[0] === 'git' && c.cmd[1] === 'fetch')?.cmd
    ).toEqual(['git', 'fetch', 'origin', 'main']);
    expect(
      stub.calls.find((c) => c.cmd[0] === 'git' && c.cmd[1] === 'rebase')?.cmd
    ).toEqual(['git', 'rebase', 'origin/main']);
    expect(
      stub.calls.find((c) => c.cmd[0] === 'git' && c.cmd[1] === 'push')?.cmd
    ).toEqual([
      'git',
      'push',
      '--force-with-lease',
      'origin',
      expect.any(String),
    ]);
    const mergeCall = stub.calls.find(
      (c) => c.cmd[0] === 'gh' && c.cmd[1] === 'pr' && c.cmd[2] === 'merge'
    );
    expect(mergeCall?.cmd).toEqual([
      'gh',
      'pr',
      'merge',
      'https://github.com/example/repo/pull/1',
      '--squash',
    ]);

    const run = harness.orchestrator.getRun(runId);
    expect(run?.meta.reviewedAt).toBeDefined();
    expect(run?.meta.reviewAction).toBe('pr');
  });
});

describe('MergeQueue dependency gating', () => {
  // This is also the regression test for the stacked case: task B is
  // dispatched off task A's branch (A is `in-review` with an unmerged run,
  // which is exactly the stacking trigger), so once A is merged and its
  // branch removed, B's `baseBranch` points at a branch that no longer
  // exists and the merge used to be refused with "merge target is main,
  // expected dispatch/…-task-a-…". What makes it pass is
  // MergeQueue.restackDependents: A is merged *outside* the queue here, so
  // the restack has to be driven by the onRunReviewed hook and has to run
  // before the queue picks B up.
  it('shows waiting-blockers for a task blocked on an undone task, then processes once the blocker is done', async () => {
    const harness = makeHarness();
    const { runId: runA, taskId: taskA } = await dispatchAndFinish(
      harness,
      'Task A'
    );
    const taskB = harness.store.create({
      title: 'Task B',
      blockedBy: [taskA],
    });
    const metaB = await harness.orchestrator.dispatch(taskB.meta.id, 'fake');
    await waitFor(
      () => harness.orchestrator.getRun(metaB.id)?.meta.state === 'finished'
    );
    const runB = metaB.id;

    const stub = new StubRunner();
    const queue = new MergeQueue(harness, stub.run);

    queue.enqueue(runB);
    await waitFor(
      () =>
        queue.snapshot().entries.find((e) => e.runId === runB)?.state ===
        'waiting-blockers'
    );
    // Must not have started processing runB while blocked.
    expect(stub.calls.length).toBe(0);

    // Merge task A directly via the orchestrator (outside the queue) — its
    // onRunReviewed hook should nudge the queue to re-check runB.
    harness.orchestrator.review(runA, 'merge');

    await waitFor(() => queue.snapshot().history.length === 1);
    expect(queue.snapshot().history[0].runId).toBe(runB);
    expect(queue.snapshot().history[0].state).toBe('merged');
  });
});

describe('MergeQueue.enqueueStack', () => {
  // Builds a 3-task stack a <- b <- c (b blockedBy a, c blockedBy b),
  // dispatches+finishes all three runs, then marks a's run reviewed/merged
  // so task a lands in `done` — the shape the TDD scenario in the task spec
  // asks for: a(done) <- b(reviewable) <- c(reviewable). Every call here is
  // synchronous with respect to the queue's own pump() (which always yields
  // on its own `await Promise.resolve()` before touching an entry — see its
  // comment), so nothing enqueued below has had a chance to start
  // processing by the time each test's assertions run.
  async function makeStack(harness: Harness): Promise<{
    taskA: string;
    taskB: string;
    taskC: string;
    runB: string;
    runC: string;
  }> {
    const { runId: runA, taskId: taskA } = await dispatchAndFinish(
      harness,
      'A'
    );
    harness.orchestrator.review(runA, 'merge');

    const taskB = harness.store.create({ title: 'B', blockedBy: [taskA] });
    const metaB = await harness.orchestrator.dispatch(taskB.meta.id, 'fake');
    await waitFor(
      () => harness.orchestrator.getRun(metaB.id)?.meta.state === 'finished'
    );

    const taskC = harness.store.create({
      title: 'C',
      blockedBy: [taskB.meta.id],
    });
    const metaC = await harness.orchestrator.dispatch(taskC.meta.id, 'fake');
    await waitFor(
      () => harness.orchestrator.getRun(metaC.id)?.meta.state === 'finished'
    );

    return {
      taskA,
      taskB: taskB.meta.id,
      taskC: taskC.meta.id,
      runB: metaB.id,
      runC: metaC.id,
    };
  }

  it('enqueues b then c in dependency order, skipping done task a', async () => {
    const harness = makeHarness();
    const { taskA, taskB, taskC, runB, runC } = await makeStack(harness);
    const stub = new StubRunner();
    const queue = new MergeQueue(harness, stub.run);

    const entries = queue.enqueueStack(taskC);
    expect(entries.map((e) => e.taskId)).toEqual([taskB, taskC]);
    expect(entries.map((e) => e.runId)).toEqual([runB, runC]);

    const snapshotTaskIds = queue.snapshot().entries.map((e) => e.taskId);
    expect(snapshotTaskIds).toEqual([taskB, taskC]);
    expect(snapshotTaskIds).not.toContain(taskA);
  });

  it('skips a run already sitting in the queue and enqueues the rest', async () => {
    const harness = makeHarness();
    const { taskC, runB, runC } = await makeStack(harness);
    const stub = new StubRunner();
    // Stall the rebase indefinitely so runB's entry stays live (present in
    // `entries`, mid-processing) rather than racing to merged/failed before
    // enqueueStack below gets to check it — mirrors the stalling pattern in
    // the "409s removing the actively-processing entry" test above.
    let resolveRebase: (() => void) | undefined;
    const originalRun = stub.run;
    stub.run = async (cwd: string, cmd: string[]): Promise<CommandResult> => {
      if (cmd[1] === 'rebase' && cmd[2] !== '--abort') {
        await new Promise<void>((resolve) => {
          resolveRebase = resolve;
        });
      }
      return originalRun(cwd, cmd);
    };
    const queue = new MergeQueue(harness, stub.run);

    queue.enqueue(runB);
    await waitFor(
      () =>
        queue.snapshot().entries.find((e) => e.runId === runB)?.state ===
        'rebasing'
    );

    const entries = queue.enqueueStack(taskC);
    expect(entries.map((e) => e.taskId)).toEqual([taskC]);
    expect(entries[0].runId).toBe(runC);

    resolveRebase?.();
    await waitFor(() => queue.snapshot().history.length === 1);
  });

  it('409s when nothing in the stack is reviewable', () => {
    const harness = makeHarness();
    const task = harness.store.create({ title: 'Lonely task' });
    const stub = new StubRunner();
    const queue = new MergeQueue(harness, stub.run);
    expect(() => queue.enqueueStack(task.meta.id)).toThrow(
      OrchestratorConflictError
    );
  });

  it('persists enqueueStack entries across a fresh MergeQueue over the same rootDir', async () => {
    const harness = makeHarness();
    const { taskC, runB, runC } = await makeStack(harness);
    const stub = new StubRunner();
    const queue1 = new MergeQueue(harness, stub.run);
    queue1.enqueueStack(taskC);

    // A second MergeQueue over the exact same rootDir stands in for a daemon
    // restart — it must reload what queue1 just persisted synchronously via
    // broadcast()'s writeFileSync, not start from an empty queue.
    const queue2 = new MergeQueue(harness, stub.run);
    const runIds = queue2.snapshot().entries.map((e) => e.runId);
    expect(runIds).toContain(runB);
    expect(runIds).toContain(runC);
  });
});

describe('MergeQueue.remove', () => {
  it('dequeues a queued entry', async () => {
    const harness = makeHarness();
    const { runId: runA } = await dispatchAndFinish(harness, 'A');
    const taskBlockerId = harness.store.create({ title: 'blocker' }).meta.id;
    const taskB = harness.store.create({
      title: 'B',
      blockedBy: [taskBlockerId],
    });
    const metaB = await harness.orchestrator.dispatch(taskB.meta.id, 'fake');
    await waitFor(
      () => harness.orchestrator.getRun(metaB.id)?.meta.state === 'finished'
    );

    const stub = new StubRunner();
    const queue = new MergeQueue(harness, stub.run);
    queue.enqueue(runA);
    queue.enqueue(metaB.id);
    // runA processes immediately (no blockers); wait for it to land in
    // history so the queue is idle before exercising remove() on runB.
    await waitFor(() => queue.snapshot().history.length === 1);

    queue.remove(metaB.id);
    expect(
      queue.snapshot().entries.find((e) => e.runId === metaB.id)
    ).toBeUndefined();
  });

  it('409s removing the actively-processing entry', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    // Delay the rebase call so the entry is still "active" when remove() is
    // called mid-processing.
    let resolveRebase: (() => void) | undefined;
    const originalRun = stub.run;
    stub.run = async (cwd: string, cmd: string[]): Promise<CommandResult> => {
      if (cmd[1] === 'rebase' && cmd[2] !== '--abort') {
        await new Promise<void>((resolve) => {
          resolveRebase = resolve;
        });
      }
      return originalRun(cwd, cmd);
    };
    const queue = new MergeQueue(harness, stub.run);
    queue.enqueue(runId);

    await waitFor(
      () =>
        queue.snapshot().entries.find((e) => e.runId === runId)?.state ===
        'rebasing'
    );
    expect(() => queue.remove(runId)).toThrow(OrchestratorConflictError);

    resolveRebase?.();
    await waitFor(() => queue.snapshot().history.length === 1);
  });

  it('404s removing a run that is not in the queue', () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    const queue = new MergeQueue(harness, stub.run);
    expect(() => queue.remove('r-nope')).toThrow(OrchestratorNotFoundError);
  });
});

describe('MergeQueue persistence', () => {
  it('reloads a queued entry into a freshly constructed MergeQueue over the same rootDir', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const queue1 = new MergeQueue(harness, stub.run);
    queue1.enqueue(runId);

    // A second MergeQueue over the exact same rootDir/orchestrator stands in
    // for a daemon restart: it must reload what queue1 just persisted rather
    // than starting from an empty queue. Everything above and below runs
    // synchronously with no `await` in between — pump() always yields on its
    // own `await Promise.resolve()` before touching any entry (see its
    // comment), so nothing has had a chance to advance this entry past
    // `queued` yet.
    const queue2 = new MergeQueue(harness, stub.run);
    const reloaded = queue2.snapshot().entries.find((e) => e.runId === runId);
    expect(reloaded?.state).toBe('queued');
  });

  it('files a mid-flight persisted entry to failed history with a restart reason', async () => {
    const harness = makeHarness();
    const { runId, taskId } = await dispatchAndFinish(harness);
    // Simulate what a previous daemon process would have left on disk had it
    // died partway through process() — the entry never reached finish().
    mkdirSync(runsDir(harness.rootDir), { recursive: true });
    writeFileSync(
      mergeQueuePath(harness.rootDir),
      JSON.stringify({
        entries: [
          {
            runId,
            taskId,
            taskTitle: 'Ship it',
            state: 'merging',
            enqueuedAt: new Date().toISOString(),
          },
        ],
        history: [],
      })
    );

    const stub = new StubRunner();
    const queue = new MergeQueue(harness, stub.run);

    const filed = queue.snapshot().history.find((e) => e.runId === runId);
    expect(filed?.state).toBe('failed');
    expect(filed?.reason).toContain('daemon restarted mid-merge');
    expect(
      queue.snapshot().entries.find((e) => e.runId === runId)
    ).toBeUndefined();
    // The run itself is still unreviewed — process() only reviews a run at
    // the very end of merge(), so a mid-flight death never got that far.
    const run = harness.orchestrator.getRun(runId);
    expect(run?.meta.reviewedAt).toBeUndefined();
  });

  it('starts with an empty queue when the persisted file is corrupt', () => {
    const harness = makeHarness();
    mkdirSync(runsDir(harness.rootDir), { recursive: true });
    writeFileSync(mergeQueuePath(harness.rootDir), '{not valid json');

    const stub = new StubRunner();
    const queue = new MergeQueue(harness, stub.run);
    expect(queue.snapshot()).toEqual({ entries: [], history: [] });
  });

  it('drops a reloaded entry to failed history when its run was reviewed while the daemon was down', async () => {
    const harness = makeHarness();
    const { runId, taskId } = await dispatchAndFinish(harness);
    mkdirSync(runsDir(harness.rootDir), { recursive: true });
    writeFileSync(
      mergeQueuePath(harness.rootDir),
      JSON.stringify({
        entries: [
          {
            runId,
            taskId,
            taskTitle: 'Ship it',
            state: 'queued',
            enqueuedAt: new Date().toISOString(),
          },
        ],
        history: [],
      })
    );

    // Something else (a manual merge, the PR poller) resolves the run
    // directly, outside the queue, while the daemon is down.
    harness.orchestrator.review(runId, 'discard');

    const stub = new StubRunner();
    const queue = new MergeQueue(harness, stub.run);

    const dropped = queue.snapshot().history.find((e) => e.runId === runId);
    expect(dropped?.state).toBe('failed');
    expect(dropped?.reason).toContain('already reviewed');
    expect(
      queue.snapshot().entries.find((e) => e.runId === runId)
    ).toBeUndefined();
  });
});

describe('MergeQueue restack of stacked dependents', () => {
  it('restacks a dependent run after its blocker merges, and resyncs its worktree', async () => {
    const harness = makeHarness();
    const { blockerRun, dependentRun } = await makeStackedPair(harness);
    const queue = new MergeQueue(harness, noJjRunner);

    const tipBefore = runGitSync(harness.rootDir, [
      'rev-parse',
      dependentRun.branch,
    ]).trim();

    queue.enqueue(blockerRun.id);
    await waitFor(() =>
      queue.snapshot().history.some((e) => e.state === 'merged')
    );

    // The dependent's branch must have moved (restacked onto the new base)...
    const tipAfter = runGitSync(harness.rootDir, [
      'rev-parse',
      dependentRun.branch,
    ]).trim();
    expect(tipAfter).not.toBe(tipBefore);

    // ...its worktree must be reattached to that branch, not left detached...
    expect(
      runGitSync(dependentRun.worktreePath, [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ]).trim()
    ).toBe(dependentRun.branch);

    // ...it must now contain the blocker's merged work...
    expect(
      await Bun.file(join(dependentRun.worktreePath, 'a.txt')).exists()
    ).toBe(true);

    // ...it must still contain its own work...
    expect(
      await Bun.file(join(dependentRun.worktreePath, 'b.txt')).exists()
    ).toBe(true);

    // ...and its baseBranch must be repointed off the now-merged blocker
    // branch, which no longer exists at all.
    const updated = harness.orchestrator
      .list()
      .find((r) => r.id === dependentRun.id);
    expect(updated?.baseBranch).not.toBe(blockerRun.branch);
    expect(updated?.baseBranch).toBe('main');
  });

  it('writes a backup ref holding the dependent tip before restacking it', async () => {
    const harness = makeHarness();
    const { blockerRun, dependentRun } = await makeStackedPair(harness);
    const queue = new MergeQueue(harness, noJjRunner);
    const tipBefore = runGitSync(harness.rootDir, [
      'rev-parse',
      dependentRun.branch,
    ]).trim();

    queue.enqueue(blockerRun.id);
    await waitFor(() =>
      queue.snapshot().history.some((e) => e.state === 'merged')
    );

    const backups = runGitSync(harness.rootDir, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/dispatch/backup',
    ]);
    expect(backups).toContain(dependentRun.id);
    expect(backups).toContain(tipBefore);
  });

  it('restacks via plain git when jj is unavailable, replaying only the dependent commits', async () => {
    const harness = makeHarness();
    const { blockerRun, dependentRun } = await makeStackedPair(harness);
    const queue = new MergeQueue(harness, noJjRunner);
    const tipBefore = runGitSync(harness.rootDir, [
      'rev-parse',
      dependentRun.branch,
    ]).trim();

    queue.enqueue(blockerRun.id);
    await waitFor(() =>
      queue.snapshot().history.some((e) => e.state === 'merged')
    );

    // Same user-visible outcome as the jj path: the dependent really moved,
    // its worktree is reattached, and it is off the merged blocker's branch.
    expect(
      runGitSync(harness.rootDir, ['rev-parse', dependentRun.branch]).trim()
    ).not.toBe(tipBefore);
    expect(
      harness.orchestrator.list().find((r) => r.id === dependentRun.id)
        ?.baseBranch
    ).toBe('main');
    expect(
      runGitSync(dependentRun.worktreePath, [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ]).trim()
    ).toBe(dependentRun.branch);
    expect(
      await Bun.file(join(dependentRun.worktreePath, 'a.txt')).exists()
    ).toBe(true);
    expect(
      await Bun.file(join(dependentRun.worktreePath, 'b.txt')).exists()
    ).toBe(true);

    // The blocker's work must appear in the dependent's history exactly ONCE.
    // A bare `git rebase <newBase>` would replay the blocker's own commit on
    // top of the squashed copy the base already holds — two commits touching
    // a.txt, or a conflict. `--onto <newBase> <stackBaseCommit>` replays only
    // the dependent's own commits, so a.txt arrives solely via the squash.
    const aTouches = runGitSync(dependentRun.worktreePath, [
      'log',
      '--oneline',
      '--',
      'a.txt',
    ])
      .split('\n')
      .filter((line) => line.trim().length > 0);
    expect(aTouches).toHaveLength(1);
    // ...and the dependent's own commit survived, exactly once.
    const bTouches = runGitSync(dependentRun.worktreePath, [
      'log',
      '--oneline',
      '--',
      'b.txt',
    ])
      .split('\n')
      .filter((line) => line.trim().length > 0);
    expect(bTouches).toHaveLength(1);
  });

  it('uses jj rebase -s over the dependent commit range when the repo is colocated', async () => {
    const harness = makeHarness();
    const { blockerRun, dependentRun } = await makeStackedPair(harness);
    const { run, jjCalls } = makeJjStubRunner();
    const queue = new MergeQueue(harness, run);
    const tipBefore = runGitSync(harness.rootDir, [
      'rev-parse',
      dependentRun.branch,
    ]).trim();

    queue.enqueue(blockerRun.id);
    await waitFor(() =>
      queue.snapshot().history.some((e) => e.state === 'merged')
    );

    // The entry's own rebase goes through jj too, so descendants follow it.
    expect(jjCalls).toContainEqual([
      'jj',
      'rebase',
      '-b',
      blockerRun.branch,
      '-d',
      'main',
    ]);
    // The dependent is restacked with -s over ONLY its own commits, never -b
    // over the whole branch.
    expect(jjCalls).toContainEqual([
      'jj',
      'rebase',
      '-s',
      `roots(${dependentRun.stackBaseCommit ?? ''}..${dependentRun.branch})`,
      '-d',
      'main',
      '--skip-emptied',
    ]);
    // jj here is a stub that moves nothing, so an unchanged dependent tip is
    // proof the plain-git fallback did not also run.
    expect(
      runGitSync(harness.rootDir, ['rev-parse', dependentRun.branch]).trim()
    ).toBe(tipBefore);

    const updated = harness.orchestrator
      .list()
      .find((r) => r.id === dependentRun.id);
    expect(updated?.baseBranch).toBe('main');
  });
});

describe('MergeQueue restack edge cases', () => {
  // The mainline shape of stacked dispatch, not an edge case: task B is
  // dispatched off task A's branch precisely BECAUSE A is only `in-review`,
  // so B's agent is very often still working when the user merges A. B is
  // untouchable at that moment (its agent owns the worktree), so the restack
  // has to happen when B itself goes terminal.
  it('restacks a dependent that was still live when its blocker merged, once it finishes', async () => {
    const harness = makeHarness();
    const { runId: runA, taskId: taskA } = await dispatchAndFinish(
      harness,
      'Task A'
    );
    const blockerRun = harness.orchestrator.list().find((r) => r.id === runA)!;
    commitFile(blockerRun.worktreePath, 'a.txt', 'A work');

    // B pauses at an approval gate, then commits its own work once released.
    harness.orchestrator.registerExecutor(
      'gated',
      new FakeExecutor({
        steps: [
          { approval: { requestId: 'gate', toolName: 'noop', input: {} } },
          {
            write: (cwd: string) => {
              writeFileSync(join(cwd, 'b.txt'), 'B work\n');
            },
            commitMessage: 'B work',
          },
        ],
        finish: { state: 'finished', costUsd: 0, turns: 1 },
      })
    );
    const taskB = harness.store.create({ title: 'Task B', blockedBy: [taskA] });
    const metaB = await harness.orchestrator.dispatch(taskB.meta.id, 'gated');
    await waitFor(
      () =>
        harness.orchestrator.getRun(metaB.id)?.meta.state ===
        'awaiting-approval'
    );
    expect(
      harness.orchestrator.list().find((r) => r.id === metaB.id)?.stackParents
    ).toEqual([blockerRun.branch]);

    const queue = new MergeQueue(harness, noJjRunner);
    queue.enqueue(runA);
    await waitFor(() =>
      queue.snapshot().history.some((e) => e.state === 'merged')
    );

    // While B is live it must not have been touched OR flagged — its agent
    // still owns that worktree.
    const midway = harness.orchestrator.list().find((r) => r.id === metaB.id)!;
    expect(midway.baseBranch).toBe(blockerRun.branch);
    expect(midway.baseDiscarded).toBeUndefined();

    harness.orchestrator.approve(metaB.id, 'gate', true);
    await waitFor(
      () => harness.orchestrator.getRun(metaB.id)?.meta.state === 'finished'
    );

    // Reaching a terminal state is what makes it safe, and the queue picks it
    // up from there.
    await waitFor(
      () =>
        harness.orchestrator.list().find((r) => r.id === metaB.id)
          ?.baseBranch === 'main'
    );
    const restacked = harness.orchestrator
      .list()
      .find((r) => r.id === metaB.id)!;
    expect(restacked.baseDiscarded).toBeUndefined();
    expect(await Bun.file(join(restacked.worktreePath, 'a.txt')).exists()).toBe(
      true
    );
    expect(await Bun.file(join(restacked.worktreePath, 'b.txt')).exists()).toBe(
      true
    );
    expect(
      runGitSync(restacked.worktreePath, [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ]).trim()
    ).toBe(restacked.branch);
  });

  // A run branched off a multi-parent jj merge base cannot be moved onto any
  // single blocker's base without dropping the other blockers' work. Skipping
  // it silently is worse than refusing: its remaining blockers merge one by
  // one and it is never repaired, until the queue eventually fails it with an
  // opaque "merge target is main, expected dispatch/stack-base-…".
  it('flags a multi-parent dependent instead of silently skipping it, exactly once', async () => {
    const jjCalls: string[][] = [];
    const jj = new JjManager(repo, (_cwd, cmd) => {
      jjCalls.push(cmd);
      return Promise.resolve({ ok: true, stdout: '', stderr: '' });
    });
    const harness = makeHarness(jj);

    const { runId: runA, taskId: taskA } = await dispatchAndFinish(
      harness,
      'Blocker A'
    );
    const blockerA = harness.orchestrator.list().find((r) => r.id === runA)!;
    commitFile(blockerA.worktreePath, 'a.txt', 'A work');
    const { runId: runB, taskId: taskB } = await dispatchAndFinish(
      harness,
      'Blocker B'
    );
    const blockerB = harness.orchestrator.list().find((r) => r.id === runB)!;
    commitFile(blockerB.worktreePath, 'b.txt', 'B work');

    // The jj stub never runs real jj, so stand the merge-base bookmark up as
    // a real git ref the way stacked-dispatch.test.ts does — pointed at one
    // blocker's tip, which is enough to reproduce the shape under test: a
    // base branch that is NOT any single blocker's branch.
    const taskC = harness.store.create({
      title: 'Task C',
      blockedBy: [taskA, taskB],
    });
    runGitSync(harness.rootDir, [
      'branch',
      `dispatch/stack-base-${taskC.meta.id}`,
      blockerA.branch,
    ]);
    const metaC = await harness.orchestrator.dispatch(taskC.meta.id, 'fake');
    await waitFor(
      () => harness.orchestrator.getRun(metaC.id)?.meta.state === 'finished'
    );
    const dependent = harness.orchestrator
      .list()
      .find((r) => r.id === metaC.id)!;
    expect(dependent.stackParents).toEqual([blockerA.branch, blockerB.branch]);
    expect(dependent.baseBranch).toBe(`dispatch/stack-base-${taskC.meta.id}`);

    const queue = new MergeQueue(harness, noJjRunner);
    queue.enqueue(runA);
    await waitFor(() =>
      queue.snapshot().history.some((e) => e.state === 'merged')
    );

    const flagged = harness.orchestrator.list().find((r) => r.id === metaC.id)!;
    expect(flagged.baseDiscarded).toBe(true);
    expect(flagged.error).toContain('multi-parent base');
    expect(flagged.error).toContain(`dispatch/stack-base-${taskC.meta.id}`);
    // Its base is left exactly as it was — nothing was guessed at.
    expect(flagged.baseBranch).toBe(`dispatch/stack-base-${taskC.meta.id}`);
    // ...and the run's own task says so, not just the run's error field.
    expect(harness.store.get(taskC.meta.id)?.body).toContain(
      'multi-parent base'
    );
    // Restart-equivalent: the flag survives a transcript replay.
    expect(
      replayTranscript(transcriptPath(harness.rootDir, metaC.id))?.meta
        .baseDiscarded
    ).toBe(true);

    // The SECOND blocker merging must not re-flag or re-process it.
    queue.enqueue(runB);
    await waitFor(() => queue.snapshot().history.length === 2);
    const activity = harness.store.get(taskC.meta.id)?.body ?? '';
    expect(activity.split('multi-parent base')).toHaveLength(2);
  });

  // jj moves refs/heads/<branch> from the project root while the run's own
  // worktree has that branch checked out, so HEAD there starts resolving to
  // the rebased commit while the index and working tree still hold pre-rebase
  // content. verify() runs in that worktree and merge() squashes the branch —
  // without an explicit resync the queue verifies one tree and merges another.
  it('resyncs the entry own worktree after a jj rebase, so verify sees post-rebase content', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness, 'Task A');
    const run = harness.orchestrator.list().find((r) => r.id === runId)!;
    commitFile(run.worktreePath, 'a.txt', 'A work');

    // A commit that exists only on the base — the rebase is what should bring
    // it into the run's worktree.
    writeFileSync(join(harness.rootDir, 'late.txt'), 'landed on main\n');
    runGitSync(harness.rootDir, ['add', 'late.txt']);
    runGitSync(harness.rootDir, ['commit', '-m', 'late main commit']);

    // verify() passes only if the worktree really holds post-rebase content.
    writeVerifyCommand(harness.rootDir, 'test -f late.txt');

    // A jj stub that actually moves the branch ref, the way `jj git export`
    // does. Moving it to the destination tip is the shape jj produces when
    // the rebased commit is emptied (`--skip-emptied`); what matters here is
    // that the ref moves from OUTSIDE the worktree holding it.
    const runner: CommandRunner = async (cwd, cmd) => {
      if (cmd[0] !== 'jj') return defaultCommandRunner(cwd, cmd);
      if (cmd[1] === 'rebase' && cmd[2] === '-b') {
        const target = runGitSync(harness.rootDir, [
          'rev-parse',
          cmd[5],
        ]).trim();
        runGitSync(harness.rootDir, [
          'update-ref',
          `refs/heads/${cmd[3]}`,
          target,
        ]);
      }
      return { ok: true, stdout: '', stderr: '' };
    };
    const queue = new MergeQueue(harness, runner);

    queue.enqueue(runId);
    await waitFor(() => queue.snapshot().history.length === 1);

    expect(queue.snapshot().history[0].reason).toBeUndefined();
    expect(queue.snapshot().history[0].state).toBe('merged');
  });

  // markRunMergedViaPr deliberately merges nothing locally — the blocker's
  // content landed on the REMOTE base. Replaying a dependent onto the local
  // base branch would drop the blocker's files entirely.
  it('restacks a PR-merged blocker dependents onto origin/<base>, not the stale local base', async () => {
    const harness = makeHarness();
    // A real remote, so `origin/main` is a ref the restack can actually use.
    const remote = mkdtempSync(join(tmpdir(), 'dispatch-remote-'));
    runGitSync(remote, ['init', '--bare', '-b', 'main']);
    runGitSync(harness.rootDir, ['remote', 'add', 'origin', remote]);
    runGitSync(harness.rootDir, ['push', '-u', 'origin', 'main']);

    const { blockerRun, dependentRun } = await makeStackedPair(harness);
    harness.orchestrator.setRunPrUrl(
      blockerRun.id,
      'https://github.com/example/repo/pull/1'
    );

    const calls: string[][] = [];
    const runner: CommandRunner = async (cwd, cmd) => {
      calls.push(cmd);
      if (cmd[0] === 'jj') {
        return { ok: false, stdout: '', stderr: 'jj: command not found' };
      }
      if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'merge') {
        // Stand in for GitHub landing the PR: the blocker's work appears on
        // the REMOTE main while the local main stays exactly where it was.
        runGitSync(harness.rootDir, [
          'push',
          'origin',
          `${blockerRun.branch}:main`,
        ]);
        // ...and this daemon has not seen it yet, so the remote-tracking ref
        // is stale until something fetches.
        runGitSync(harness.rootDir, [
          'update-ref',
          '-d',
          'refs/remotes/origin/main',
        ]);
        return { ok: true, stdout: '', stderr: '' };
      }
      return defaultCommandRunner(cwd, cmd);
    };
    const queue = new MergeQueue(harness, runner);

    queue.enqueue(blockerRun.id);
    await waitFor(() =>
      queue.snapshot().history.some((e) => e.state === 'merged')
    );

    // The restack refreshed the remote-tracking ref itself...
    expect(
      calls.filter((c) => c[0] === 'git' && c[1] === 'fetch' && c[3] === 'main')
        .length
    ).toBeGreaterThan(0);
    // ...and replayed the dependent onto it, so the blocker's work is present
    // even though the LOCAL main still knows nothing about it.
    expect(
      await Bun.file(join(dependentRun.worktreePath, 'a.txt')).exists()
    ).toBe(true);
    expect(await Bun.file(join(harness.rootDir, 'a.txt')).exists()).toBe(false);
    expect(
      Bun.spawnSync(
        [
          'git',
          'merge-base',
          '--is-ancestor',
          'origin/main',
          dependentRun.branch,
        ],
        { cwd: dependentRun.worktreePath, stdout: 'pipe', stderr: 'pipe' }
      ).exitCode
    ).toBe(0);
    // The recorded base is the plain branch name — `origin/` is a rebase
    // target, never something mergeRun() compares the main checkout against.
    const updated = harness.orchestrator
      .list()
      .find((r) => r.id === dependentRun.id);
    expect(updated?.baseBranch).toBe('main');
    expect(updated?.baseDiscarded).toBeUndefined();

    rmSync(remote, { recursive: true, force: true });
  });

  // Restart-equivalent for the success path: the repointed base has to be on
  // disk, not just in the in-memory registry.
  it('persists a repointed baseBranch so a transcript replay recovers it', async () => {
    const harness = makeHarness();
    const { blockerRun, dependentRun } = await makeStackedPair(harness);
    const queue = new MergeQueue(harness, noJjRunner);

    queue.enqueue(blockerRun.id);
    await waitFor(() =>
      queue.snapshot().history.some((e) => e.state === 'merged')
    );

    const replayed = replayTranscript(
      transcriptPath(harness.rootDir, dependentRun.id)
    );
    expect(replayed?.meta.baseBranch).toBe('main');
    expect(replayed?.meta.baseBranch).not.toBe(blockerRun.branch);
  });
});

describe('MergeQueue multi-parent dependent that was live when its blocker merged', () => {
  // The gap the terminal/boot path originally had: keying the stale-run check
  // on `baseBranch` alone made the multi-parent shape invisible to it, because
  // a multi-parent run's base is a jj merge-base bookmark that is NOT any
  // blocker's branch. Such a run was skipped by restackDependents (still live)
  // and then matched nothing on the terminal path either — neither restacked
  // nor flagged, with nothing to re-examine it on reboot.
  it('flags it once it goes terminal, and preserves its own failure message', async () => {
    const jj = new JjManager(repo, (_cwd, cmd) => {
      void cmd;
      return Promise.resolve({ ok: true, stdout: '', stderr: '' });
    });
    const harness = makeHarness(jj);

    const { runId: runA, taskId: taskA } = await dispatchAndFinish(
      harness,
      'Blocker A'
    );
    const blockerA = harness.orchestrator.list().find((r) => r.id === runA)!;
    commitFile(blockerA.worktreePath, 'a.txt', 'A work');
    const { taskId: taskB } = await dispatchAndFinish(harness, 'Blocker B');

    // C is blocked on BOTH, so it is branched off a multi-parent merge base.
    // It also pauses at an approval gate, so it is still LIVE when A merges,
    // and then fails — which is what exercises error preservation.
    harness.orchestrator.registerExecutor(
      'gated-fail',
      new FakeExecutor({
        steps: [
          { approval: { requestId: 'gate', toolName: 'noop', input: {} } },
        ],
        finish: { state: 'failed', error: 'agent ran out of budget' },
      })
    );
    const taskC = harness.store.create({
      title: 'Task C',
      blockedBy: [taskA, taskB],
    });
    const stackBase = `dispatch/stack-base-${taskC.meta.id}`;
    runGitSync(harness.rootDir, ['branch', stackBase, blockerA.branch]);
    const metaC = await harness.orchestrator.dispatch(
      taskC.meta.id,
      'gated-fail'
    );
    await waitFor(
      () =>
        harness.orchestrator.getRun(metaC.id)?.meta.state ===
        'awaiting-approval'
    );
    const dependent = harness.orchestrator
      .list()
      .find((r) => r.id === metaC.id)!;
    // The exact shape the stale-run check has to recognise: the base is the
    // bookmark, and it is NOT among the recorded stack parents.
    expect(dependent.baseBranch).toBe(stackBase);
    expect(dependent.stackParents).not.toContain(stackBase);
    expect(dependent.stackParents).toContain(blockerA.branch);

    const queue = new MergeQueue(harness, noJjRunner);
    queue.enqueue(runA);
    await waitFor(() =>
      queue.snapshot().history.some((e) => e.state === 'merged')
    );

    // Untouched and unflagged while its agent still owns the worktree.
    expect(
      harness.orchestrator.list().find((r) => r.id === metaC.id)?.baseDiscarded
    ).toBeUndefined();

    harness.orchestrator.approve(metaC.id, 'gate', true);
    await waitFor(
      () => harness.orchestrator.getRun(metaC.id)?.meta.state === 'failed'
    );

    // Going terminal is what makes it reachable, and it must be FLAGGED —
    // a multi-parent base cannot be restacked onto one blocker's base.
    await waitFor(
      () =>
        harness.orchestrator.list().find((r) => r.id === metaC.id)
          ?.baseDiscarded === true
    );
    const flagged = harness.orchestrator.list().find((r) => r.id === metaC.id)!;
    expect(flagged.baseBranch).toBe(stackBase);
    // The run's OWN failure message survives the flag — it says why the work
    // is broken, where the restack reason only says why the base could not
    // move, and the write is persisted so clobbering it would be permanent.
    expect(flagged.error).toBe('agent ran out of budget');
    // ...and the restack reason still reaches the user, on the task.
    const activity = harness.store.get(taskC.meta.id)?.body ?? '';
    expect(activity).toContain('multi-parent base');
    // Restart-equivalent: both the flag and the original error replay.
    const replayed = replayTranscript(
      transcriptPath(harness.rootDir, metaC.id)
    );
    expect(replayed?.meta.baseDiscarded).toBe(true);
    expect(replayed?.meta.error).toBe('agent ran out of budget');

    // A second pass (the boot sweep re-deriving from durable state) must not
    // flag it again.
    const queue2 = new MergeQueue(harness, noJjRunner);
    await waitFor(() => queue2.snapshot().entries.length === 0);
    expect(activity.split('multi-parent base')).toHaveLength(2);
  });
});

describe('MergeQueue refuses a run whose base was discarded', () => {
  // The plain discard flow, with NO manual state tampering: discarding
  // blockerRun reopens task A to 'todo' (Orchestrator.review's discard
  // branch), which is exactly the task id stacked dispatch put in task B's
  // `blockedBy` — so B's task-level dependency gate (nextEligible's `unmet`
  // check, a separate and correctly-behaving mechanism; see "MergeQueue
  // dependency gating" above) would be unmet forever. A `baseDiscarded` run
  // is broken, not merely waiting, so nextEligible has to let it through
  // regardless and fail it fast with a reason the user can act on, rather
  // than leaving it silently parked at 'waiting-blockers'.
  it('fails fast with a reason naming the base, never parking at waiting-blockers', async () => {
    const harness = makeHarness();
    const { blockerRun, dependentRun } = await makeStackedPair(harness);
    harness.orchestrator.review(blockerRun.id, 'discard');

    const queue = new MergeQueue(harness, noJjRunner);
    queue.enqueue(dependentRun.id);
    await waitFor(() =>
      queue.snapshot().history.some((e) => e.state === 'failed')
    );

    const entry = queue
      .snapshot()
      .history.find((e) => e.runId === dependentRun.id)!;
    expect(entry.reason).toContain('base');
    // It must never have been left waiting — that state would mean the
    // failure (and its reason) never actually reached the user.
    expect(
      queue.snapshot().entries.find((e) => e.runId === dependentRun.id)
    ).toBeUndefined();
  });

  // A second, independent way to reach a `baseDiscarded` run: the blocker
  // genuinely MERGES (not discarded), but the restack that runs right after
  // fails for its own reason (here, an uncommitted change in the dependent's
  // worktree) and flags the dependent via flagRunRestackFailure. Here the
  // blocker's task really is 'done', so `blockedBy` is already satisfied on
  // its own — this exercises process()'s guard without any help from
  // nextEligible's baseDiscarded bypass above, confirming that guard is not
  // dead code for this path either.
  it('refuses a dependent flagged by a failed restack after its blocker actually merged', async () => {
    const harness = makeHarness();
    const { blockerRun, dependentRun } = await makeStackedPair(harness);
    // Leave the dependent's worktree dirty (an uncommitted tracked change) —
    // restackRun refuses to rewrite it out from under whatever is pending,
    // and flags it instead of guessing.
    writeFileSync(
      join(dependentRun.worktreePath, 'b.txt'),
      'B work, uncommitted\n'
    );

    const queue = new MergeQueue(harness, noJjRunner);
    queue.enqueue(blockerRun.id);
    await waitFor(() =>
      queue.snapshot().history.some((e) => e.state === 'merged')
    );

    const flagged = harness.orchestrator
      .list()
      .find((r) => r.id === dependentRun.id)!;
    expect(flagged.baseDiscarded).toBe(true);

    queue.enqueue(dependentRun.id);
    await waitFor(() =>
      queue
        .snapshot()
        .history.some(
          (e) => e.runId === dependentRun.id && e.state === 'failed'
        )
    );
    const entry = queue
      .snapshot()
      .history.find((e) => e.runId === dependentRun.id)!;
    expect(entry.reason).toContain('base');
  });
});
