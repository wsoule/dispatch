import { DISPATCH_DIR, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { EventBus } from '../src/events.js';
import type { ServerEvent } from '../src/events.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import { MergeQueue } from '../src/orchestrator/mergeQueue.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { mergeQueuePath, runsDir } from '../src/orchestrator/paths.js';
import type { CommandResult } from '../src/orchestrator/pr.js';
import {
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from '../src/orchestrator/types.js';
import { initGitRepo } from './orchestrator/helpers.js';

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

function makeHarness(): Harness {
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
