import { DISPATCH_DIR, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

// Every queue a test builds, so afterEach can stop it: a 'blocked-environment'
// entry arms a 15s self-retry that otherwise fires long after the test ended.
const liveQueues: MergeQueue[] = [];

function makeQueue(
  ...args: ConstructorParameters<typeof MergeQueue>
): MergeQueue {
  const queue = new MergeQueue(...args);
  liveQueues.push(queue);
  return queue;
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-merge-queue-');
});

afterEach(() => {
  // Before the env restore below, so a timer firing mid-teardown still writes
  // into this test's own fakeHome rather than the shared fallback one.
  for (const queue of liveQueues) queue.stop();
  liveQueues.length = 0;
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
  // Finishes with a `sessionId` because a real executor always reports one, and
  // `sendMessage(..., { resume: true })` refuses a run without one — a resume
  // with no session to resume into would start a brand new agent while
  // pretending to continue the conversation.
  orchestrator.registerExecutor(
    'fake',
    new FakeExecutor({
      finish: {
        state: 'finished',
        costUsd: 0,
        turns: 1,
        sessionId: 'sess-fake',
      },
    })
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

// jj is not a build dependency of this repo, so the real-jj tests below skip
// where the binary isn't installed — same convention stacked-dispatch.test.ts
// already uses for its own real-jj coverage.
function hasJj(): boolean {
  // Bun.spawnSync throws on a missing executable — absent jj means false.
  try {
    return (
      Bun.spawnSync(['jj', '--version'], { stdout: 'pipe', stderr: 'pipe' })
        .exitCode === 0
    );
  } catch {
    return false;
  }
}

// Converts the test repo in place to a colocated jj repo, so a MergeQueue
// built with the REAL command runner takes the jj path for real instead of
// against a stub that answers `ok` and moves nothing.
function colocate(rootDir: string): void {
  const result = Bun.spawnSync(['jj', 'git', 'init', '--colocate'], {
    cwd: rootDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `jj git init --colocate failed: ${result.stderr.toString('utf8')}`
    );
  }
}

function writeVerifyCommand(rootDir: string, cmd: string): void {
  writeFileSync(
    join(rootDir, DISPATCH_DIR, 'config.yml'),
    `verifyCommand: "${cmd}"\n`
  );
}

// The wedge that motivated the timeout: an entry sat in `verifying` for 11
// minutes with no process behind it, and because the queue is strictly serial it
// blocked everything behind it. A verify that never returns must fail the entry
// with an actionable reason and let the queue move on.
describe('MergeQueue verify timeout', () => {
  it('fails a verify that never returns, and still processes the next entry', async () => {
    const harness = makeHarness();
    writeFileSync(
      join(harness.rootDir, DISPATCH_DIR, 'config.yml'),
      'verifyCommand: "sleep 600"\norchestrator:\n  verifyTimeoutSec: 1\n'
    );
    const { runId: hangs } = await dispatchAndFinish(harness, 'Hangs');
    const { runId: fine } = await dispatchAndFinish(harness, 'Fine');

    const stub = new StubRunner();
    // Never resolves — the process-that-hangs case, independent of wall clock.
    let releaseHang: (() => void) | undefined;
    const hangUntilReleased = new Promise<CommandResult>((resolve) => {
      releaseHang = () => resolve({ ok: true, stdout: '', stderr: '' });
    });
    let verifyCalls = 0;
    const runner = async (
      cwd: string,
      cmd: string[],
      opts?: { timeoutMs?: number }
    ): Promise<CommandResult> => {
      if (cmd[0] === 'bash') {
        verifyCalls += 1;
        // Only the FIRST verify hangs, so the second entry can still complete —
        // proving a timed-out entry does not wedge the queue behind it.
        if (verifyCalls === 1) {
          if (opts?.timeoutMs === undefined) {
            throw new Error('verify must be given a timeoutMs');
          }
          // Honour the timeout the way defaultCommandRunner must: give up and
          // report failure rather than waiting forever.
          return await Promise.race([
            hangUntilReleased,
            new Promise<CommandResult>((resolve) =>
              setTimeout(
                () => resolve({ ok: false, stdout: '', stderr: 'timed out' }),
                opts.timeoutMs
              )
            ),
          ]);
        }
      }
      return await stub.run(cwd, cmd);
    };
    const queue = makeQueue(harness, runner);

    queue.enqueue(hangs);
    queue.enqueue(fine);
    await waitFor(() => queue.snapshot().history.length === 2, 20_000);

    const hung = queue.snapshot().history.find((e) => e.runId === hangs);
    expect(hung?.state).toBe('failed');
    expect(hung?.reason).toMatch(/timed out/i);
    // The remedy has to be in the message — otherwise this is the same
    // "something went wrong" dead end the wedge already was.
    expect(hung?.reason).toMatch(/verifyTimeoutSec/);

    const ok = queue.snapshot().history.find((e) => e.runId === fine);
    expect(ok?.state).toBe('merged');
    releaseHang?.();
  }, 30_000);
});

// Elapsed time is what makes "slow" and "wedged" distinguishable without
// inspecting processes. `enqueuedAt` cannot do it — it never moves — so each
// state transition stamps its own `stateSince`.
describe('MergeQueue entry stateSince', () => {
  it('stamps stateSince on enqueue and advances it on each state transition', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run);

    queue.enqueue(runId);
    const queued = queue.snapshot().entries[0];
    expect(queued.stateSince).toBeDefined();

    await waitFor(() => queue.snapshot().history.length === 1);
    const done = queue.snapshot().history[0];
    expect(done.state).toBe('merged');
    // The entry moved queued -> rebasing -> merging -> merged, so its final
    // stamp must be later than the one it carried while queued.
    expect(new Date(done.stateSince!).getTime()).toBeGreaterThanOrEqual(
      new Date(queued.stateSince!).getTime()
    );
    // And it must not simply mirror enqueuedAt, which is what it would do if
    // transitions were not stamping it.
    expect(done.stateSince).not.toBe(done.enqueuedAt);
  });
});

// Streaming exists so a multi-minute verify shows progress instead of a silent
// `verifying` that could equally be wedged. Mirrors the run.log contract: one
// event per chunk, plus a bounded tail on the entry so a client that connects
// mid-verify or refreshes still sees recent output.
describe('MergeQueue verify output streaming', () => {
  it('broadcasts each verify output chunk and keeps a bounded tail on the entry', async () => {
    const harness = makeHarness();
    writeVerifyCommand(harness.rootDir, 'echo verifying');
    const { runId } = await dispatchAndFinish(harness);
    const seen = captureEvents(harness.events);

    const stub = new StubRunner();
    const runner = async (
      cwd: string,
      cmd: string[],
      opts?: { onOutput?: (chunk: string) => void }
    ): Promise<CommandResult> => {
      if (cmd[0] === 'bash') {
        opts?.onOutput?.('building...\n');
        opts?.onOutput?.('tests passed\n');
        return { ok: true, stdout: '', stderr: '' };
      }
      return await stub.run(cwd, cmd);
    };
    const queue = makeQueue(harness, runner);

    queue.enqueue(runId);
    await waitFor(() => queue.snapshot().history.length === 1);
    expect(queue.snapshot().history[0].state).toBe('merged');

    const logs = seen.filter(
      (e): e is { type: 'merge-queue.log'; runId: string; chunk: string } =>
        e.type === 'merge-queue.log'
    );
    expect(logs.map((l) => l.chunk)).toEqual([
      'building...\n',
      'tests passed\n',
    ]);
    expect(logs.every((l) => l.runId === runId)).toBe(true);
  });

  it('bounds the retained tail rather than growing it without limit', async () => {
    const harness = makeHarness();
    writeVerifyCommand(harness.rootDir, 'echo verifying');
    const { runId } = await dispatchAndFinish(harness);

    const stub = new StubRunner();
    // Far more output than the cap, so an unbounded buffer would be obvious.
    const chunk = 'x'.repeat(1024);
    const runner = async (
      cwd: string,
      cmd: string[],
      opts?: { onOutput?: (chunk: string) => void }
    ): Promise<CommandResult> => {
      if (cmd[0] === 'bash') {
        for (let i = 0; i < 40; i++) opts?.onOutput?.(chunk);
        // Fail so the entry keeps its output for inspection.
        return { ok: false, stdout: '', stderr: 'boom' };
      }
      return await stub.run(cwd, cmd);
    };
    const queue = makeQueue(harness, runner);

    queue.enqueue(runId);
    await waitFor(() => queue.snapshot().history.length === 1);
    const entry = queue.snapshot().history[0];
    expect(entry.state).toBe('failed');
    // 40KB in; the retained tail must be capped well below that. An unbounded
    // buffer in a long-lived daemon is a leak, and the full log belongs in the
    // failure reason rather than in memory.
    expect((entry.output ?? '').length).toBeLessThanOrEqual(8192);
    expect((entry.output ?? '').length).toBeGreaterThan(0);
  });
});

describe('MergeQueue.enqueue', () => {
  it('enqueues a finished, unreviewed run as queued and broadcasts', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const seen = captureEvents(harness.events);
    const queue = makeQueue(harness, stub.run);

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
    const queue = makeQueue(harness, stub.run);
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
    const queue = makeQueue(harness, stub.run);
    expect(() => queue.enqueue(meta.id)).toThrow(OrchestratorConflictError);
  });

  it('409s a run that has already been reviewed', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    harness.orchestrator.review(runId, 'discard');
    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run);
    expect(() => queue.enqueue(runId)).toThrow(OrchestratorConflictError);
  });

  it('409s a duplicate enqueue of the same run', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    // Make the run's own rebase hang so the entry stays queued/active long
    // enough for the second enqueue call to observe it still present.
    stub.rebaseResult = { ok: true, stdout: '', stderr: '' };
    const queue = makeQueue(harness, stub.run);
    queue.enqueue(runId);
    expect(() => queue.enqueue(runId)).toThrow(OrchestratorConflictError);
  });
});

describe('MergeQueue local-run happy path', () => {
  it('rebases, skips verify (none configured), merges, and lands in history as merged', async () => {
    const harness = makeHarness();
    const { runId, taskId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run);

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

  // Without the precheck the queue ran straight into `git rebase`, whose
  // "cannot rebase: Your index contains uncommitted changes" names no worktree
  // and offers no way forward.
  it('refuses to rebase a dirty worktree, and says which one and what to do', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const run = harness.orchestrator.getRun(runId)!.meta;
    // Staged, never committed — exactly the shape a vetoed pre-commit hook
    // leaves behind.
    commitFile(run.worktreePath, 'tracked.txt', 'baseline');
    writeFileSync(join(run.worktreePath, 'tracked.txt'), 'edited\n');
    runGitSync(run.worktreePath, ['add', 'tracked.txt']);

    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run);
    queue.enqueue(runId);
    await waitFor(() => queue.snapshot().history.length === 1);

    const [entry] = queue.snapshot().history;
    expect(entry.state).toBe('failed');
    expect(entry.reason).toContain('uncommitted changes');
    expect(entry.reason).toContain(run.worktreePath);
    // The point of the precheck: git is never given the chance to fail.
    expect(stub.calls.some((c) => c.cmd[1] === 'rebase')).toBe(false);
  });

  it('runs the configured verify command between rebase and merge', async () => {
    const harness = makeHarness();
    writeVerifyCommand(harness.rootDir, 'echo verifying');
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run);

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
    const queue = makeQueue(harness, stub.run);

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
    const queue = makeQueue(harness, stub.run);

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

// A bare remote to push to — same shape as orchestrator.test.ts's
// initBareGitRepo, duplicated locally so this file's own origin/remote setup
// doesn't depend on that other suite's helper.
function initBareOrigin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-origin-'));
  runGitSync(dir, ['init', '--bare', '-b', 'main']);
  return dir;
}

// Task 6: once the queue drains with at least one merge, it pushes origin's
// copy of the base branch itself — the whole point is that a human never has
// to remember to `git push` after every merge queue run.
describe('MergeQueue auto-push on drain', () => {
  it('pushes once after draining with >=1 merge and broadcasts queue.drained', async () => {
    const origin = initBareOrigin();
    const harness = makeHarness();
    runGitSync(harness.rootDir, ['remote', 'add', 'origin', origin]);
    const events = captureEvents(harness.events);
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run);

    queue.enqueue(runId);
    await waitFor(() => queue.snapshot().entries.length === 0);

    const pushes = stub.calls.filter((c) =>
      c.cmd.join(' ').startsWith('git push origin')
    );
    expect(pushes.length).toBe(1);
    expect(pushes[0]?.cmd).toEqual(['git', 'push', 'origin', 'main']);
    const drained = events.find((e) => e.type === 'queue.drained') as {
      merged: number;
      pushed: boolean;
    };
    expect(drained).toMatchObject({ merged: 1, pushed: true });
  });

  it('reports pushError and still drains when the push fails', async () => {
    const origin = initBareOrigin();
    const harness = makeHarness();
    runGitSync(harness.rootDir, ['remote', 'add', 'origin', origin]);
    const events = captureEvents(harness.events);
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    stub.pushResult = { ok: false, stdout: '', stderr: 'no auth' };
    const queue = makeQueue(harness, stub.run);

    queue.enqueue(runId);
    await waitFor(() => queue.snapshot().entries.length === 0);

    expect(queue.snapshot().history[0]?.state).toBe('merged');
    const drained = events.find((e) => e.type === 'queue.drained') as {
      pushed: boolean;
      pushError?: string;
    };
    expect(drained.pushed).toBe(false);
    expect(drained.pushError).toContain('no auth');
  });

  it('skips the push (pushed: false, no error) when the repo has no origin remote', async () => {
    const harness = makeHarness();
    const events = captureEvents(harness.events);
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run);

    queue.enqueue(runId);
    await waitFor(() => queue.snapshot().entries.length === 0);

    expect(
      stub.calls.some((c) => c.cmd[0] === 'git' && c.cmd[1] === 'push')
    ).toBe(false);
    const drained = events.find((e) => e.type === 'queue.drained') as {
      merged: number;
      pushed: boolean;
      pushError?: string;
    };
    expect(drained).toMatchObject({ merged: 1, pushed: false });
    expect(drained.pushError).toBeUndefined();
  });

  it('retries a failed push on the next idle pump via recheck()', async () => {
    const origin = initBareOrigin();
    const harness = makeHarness();
    runGitSync(harness.rootDir, ['remote', 'add', 'origin', origin]);
    const events = captureEvents(harness.events);
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    stub.pushResult = { ok: false, stdout: '', stderr: 'no auth' };
    const queue = makeQueue(harness, stub.run);

    queue.enqueue(runId);
    await waitFor(
      () => events.filter((e) => e.type === 'queue.drained').length === 1
    );

    stub.pushResult = { ok: true, stdout: '', stderr: '' };
    queue.recheck();
    await waitFor(
      () => events.filter((e) => e.type === 'queue.drained').length === 2
    );
    const [, retried] = events.filter((e) => e.type === 'queue.drained') as {
      merged: number;
      pushed: boolean;
    }[];
    expect(retried).toMatchObject({ merged: 0, pushed: true });
  });

  // The Critical fix: `pumping` stays true for this whole pump() call,
  // including while the drain-push's `git push` is in flight, so an
  // enqueue() landing in that window has its own kick() dropped by the
  // pumping guard. Without the loop looping back (`continue`, not `return`)
  // after the push settles, that entry would strand at 'queued' forever —
  // nothing else would ever nudge pump() again.
  it('processes an entry enqueued while the drain push is still in flight, without any external kick', async () => {
    const origin = initBareOrigin();
    const harness = makeHarness();
    runGitSync(harness.rootDir, ['remote', 'add', 'origin', origin]);
    const { runId: firstRunId } = await dispatchAndFinish(harness, 'First');
    const stub = new StubRunner();

    // Stalls only the FIRST `git push origin` call indefinitely, until the
    // test resolves it by hand — everything else (including a second push,
    // should this run far enough to trigger one) goes through untouched.
    let resolvePush: (() => void) | undefined;
    let pushIntercepted = false;
    const originalRun = stub.run;
    stub.run = async (cwd: string, cmd: string[]): Promise<CommandResult> => {
      if (!pushIntercepted && cmd[0] === 'git' && cmd[1] === 'push') {
        pushIntercepted = true;
        await new Promise<void>((resolve) => {
          resolvePush = resolve;
        });
      }
      return originalRun(cwd, cmd);
    };
    const queue = makeQueue(harness, stub.run);

    queue.enqueue(firstRunId);
    // The first entry has already merged and pump() is now blocked inside
    // pushOnDrain's stalled `git push`.
    await waitFor(() => resolvePush !== undefined);
    expect(
      queue
        .snapshot()
        .history.some((e) => e.runId === firstRunId && e.state === 'merged')
    ).toBe(true);

    // A second, already-finished run enqueued WHILE the push above is still
    // pending. Its own kick() is a no-op (pumping is still true) — the only
    // thing that can ever process it is this same pump() call looping back.
    const { runId: secondRunId } = await dispatchAndFinish(harness, 'Second');
    queue.enqueue(secondRunId);
    expect(
      queue.snapshot().entries.find((e) => e.runId === secondRunId)?.state
    ).toBe('queued');

    resolvePush?.();

    await waitFor(
      () =>
        queue
          .snapshot()
          .history.some((e) => e.runId === secondRunId && e.state === 'merged'),
      2000
    );
  });
});

// The "merge queue does not work" report. A dirty main checkout is an
// ENVIRONMENTAL precondition — transient, global, and fixed by the user in
// seconds — but it used to be treated like a content failure: the entry
// fast-failed straight into history ~80ms after enqueue, so from the UI the
// queue simply swallowed the run. Environmental blockers now behave like the
// `waiting-blockers` case that already existed: the entry stays in line,
// carrying the reason, and retries once the environment clears.
describe('MergeQueue environmental blockers', () => {
  it('keeps the entry queued and blocked (not failed) when the main checkout is dirty', async () => {
    const harness = makeHarness();
    const { runId, taskId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run);

    // The exact real-world trigger: one stray untracked file at the repo root.
    writeFileSync(join(harness.rootDir, 'stray-download.zip'), 'nope\n');

    queue.enqueue(runId);
    await waitFor(
      () => queue.snapshot().entries[0]?.state === 'blocked-environment'
    );

    const snapshot = queue.snapshot();
    // Still in line — this is the whole point. Nothing in history.
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.history).toHaveLength(0);
    // And it says which file, so the user can actually act.
    expect(snapshot.entries[0].reason).toContain('stray-download.zip');

    // Nothing landed: the run is unreviewed and the task is not done.
    expect(harness.orchestrator.getRun(runId)?.meta.reviewedAt).toBeUndefined();
    expect(harness.store.get(taskId)?.meta.status).not.toBe('done');
  });

  it('merges the blocked entry once the checkout is clean again and the queue is re-checked', async () => {
    const harness = makeHarness();
    const { runId, taskId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run);

    const stray = join(harness.rootDir, 'stray-download.zip');
    writeFileSync(stray, 'nope\n');
    queue.enqueue(runId);
    await waitFor(
      () => queue.snapshot().entries[0]?.state === 'blocked-environment'
    );

    // The user cleans up, then the queue re-checks — no re-enqueue needed.
    rmSync(stray);
    queue.recheck();

    await waitFor(() => queue.snapshot().history.length === 1);
    expect(queue.snapshot().history[0].state).toBe('merged');
    expect(queue.snapshot().entries).toHaveLength(0);
    expect(harness.store.get(taskId)?.meta.status).toBe('done');
  });

  // The stale-reason half of the "merge queue does not work" report: a
  // blocked entry's reason must track the CURRENT state of the checkout, not
  // whatever first blocked it — otherwise a user who fixes one problem and
  // hits recheck sees a message describing a file that's already gone.
  it('refreshes the blocked reason on each recheck(), then merges once truly clean', async () => {
    const harness = makeHarness();
    const { runId, taskId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run);

    const strayA = join(harness.rootDir, 'stray-download.zip');
    writeFileSync(strayA, 'nope\n');
    queue.enqueue(runId);
    await waitFor(
      () => queue.snapshot().entries[0]?.state === 'blocked-environment'
    );
    expect(queue.snapshot().entries[0].reason).toContain('stray-download.zip');

    // The first blocker clears, but a different one appears before the queue
    // is re-checked — the live-incident shape this fix targets. The entry
    // stays blocked, but its reason must name the NEW offender, not the old
    // (already-gone) one.
    rmSync(strayA);
    const strayB = join(harness.rootDir, 'stray-other.txt');
    writeFileSync(strayB, 'nope\n');
    queue.recheck();
    await waitFor(
      () =>
        queue.snapshot().entries[0]?.reason?.includes('stray-other.txt') ===
        true
    );
    expect(queue.snapshot().entries[0].state).toBe('blocked-environment');
    expect(queue.snapshot().entries[0].reason).not.toContain(
      'stray-download.zip'
    );

    // Cleaning up and re-checking (recheck() is the same entry point the
    // 15s self-retry timer calls once the checkout allows it) lets the entry
    // through without ever removing/re-enqueueing it.
    rmSync(strayB);
    queue.recheck();
    await waitFor(() => queue.snapshot().history.length === 1);
    expect(queue.snapshot().history[0].state).toBe('merged');
    expect(harness.store.get(taskId)?.meta.status).toBe('done');
  });

  // The self-retry itself, isolated from recheck(): armBlockedRetry's timer is
  // the ONLY thing driving this entry forward here — deleting it would make
  // this test time out.
  it('self-retries a blocked entry via its own timer, with no recheck() call', async () => {
    const harness = makeHarness();
    const { runId, taskId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run, {
      blockedRetryDelayMs: 10,
    });

    const stray = join(harness.rootDir, 'stray-download.zip');
    writeFileSync(stray, 'nope\n');
    queue.enqueue(runId);
    await waitFor(
      () => queue.snapshot().entries[0]?.state === 'blocked-environment'
    );

    rmSync(stray);
    await waitFor(() => queue.snapshot().history.length === 1, 1000);
    expect(queue.snapshot().history[0].state).toBe('merged');
    expect(harness.store.get(taskId)?.meta.status).toBe('done');
  });

  // What teardown relies on: a queue keeping this timer past its own test
  // pumps against a deleted worktree and persists into the wrong DISPATCH_HOME.
  it('stops the blocked-retry timer, so a torn-down queue never persists again', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run, {
      blockedRetryDelayMs: 10,
    });

    const stray = join(harness.rootDir, 'stray-download.zip');
    writeFileSync(stray, 'nope\n');
    queue.enqueue(runId);
    await waitFor(
      () => queue.snapshot().entries[0]?.state === 'blocked-environment'
    );

    queue.stop();
    // Clearing the blocker and the state file makes a surviving timer loud: it
    // would pump, merge the entry, and write merge-queue.json straight back.
    rmSync(stray);
    rmSync(mergeQueuePath(harness.rootDir));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(mergeQueuePath(harness.rootDir))).toBe(false);
    expect(queue.snapshot().history).toHaveLength(0);
  });

  // The IMPORTANT fix: removing the sole blocked entry must not leave its
  // retry timer armed against an empty queue. remove()'s own kick() (added
  // alongside this test) drives pump() into the empty-queue branch, which is
  // what actually clears it.
  it('clears the blocked-retry timer when the blocked entry is removed', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run, {
      blockedRetryDelayMs: 10,
    });

    writeFileSync(join(harness.rootDir, 'stray-download.zip'), 'nope\n');
    queue.enqueue(runId);
    await waitFor(
      () => queue.snapshot().entries[0]?.state === 'blocked-environment'
    );
    // Whether the timer fired is otherwise unobservable once the queue it
    // would retry against is already empty (kicking an empty queue is a
    // silent no-op either way) — reading the private field directly is the
    // most honest way to prove remove() actually tears it down, rather than
    // asserting the absence of an effect that would be silent regardless.
    expect(
      (queue as unknown as { blockedRetryTimer: unknown }).blockedRetryTimer
    ).toBeDefined();

    // remove()'s own kick() runs pump() asynchronously (it yields on a
    // microtask before touching anything, same as every other kick()), so
    // the clear doesn't happen synchronously within this call — poll for it.
    queue.remove(runId);
    await waitFor(
      () =>
        (queue as unknown as { blockedRetryTimer: unknown })
          .blockedRetryTimer === undefined
    );

    // Belt-and-suspenders: past the (short, injected) retry delay, nothing
    // reappeared — guards against a regression where remove()'s own kick()
    // somehow re-arms the timer instead of clearing it.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(queue.snapshot().entries).toHaveLength(0);
    expect(queue.snapshot().history).toHaveLength(0);
  });

  // A blocked entry must not wedge the queue's own bookkeeping: the blocker is
  // global (one checkout), so nothing behind it could proceed either, and both
  // entries must survive to retry rather than one being failed out.
  it('holds every queued entry when the environment blocks, failing none of them', async () => {
    const harness = makeHarness();
    const { runId: first } = await dispatchAndFinish(harness, 'First');
    const { runId: second } = await dispatchAndFinish(harness, 'Second');
    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run);

    writeFileSync(join(harness.rootDir, 'stray-download.zip'), 'nope\n');
    queue.enqueue(first);
    queue.enqueue(second);
    await waitFor(
      () => queue.snapshot().entries[0]?.state === 'blocked-environment'
    );

    const snapshot = queue.snapshot();
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.history).toHaveLength(0);
  });

  // A real content conflict is NOT environmental — it needs a human to change
  // the branch, so it must still fail out to history as before. This is the
  // line the classification has to hold.
  it('still fails a genuine rebase conflict out to history', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    stub.rebaseResult = { ok: false, stdout: '', stderr: 'CONFLICT' };
    const queue = makeQueue(harness, stub.run);

    queue.enqueue(runId);
    await waitFor(() => queue.snapshot().history.length === 1);
    expect(queue.snapshot().history[0].state).toBe('failed');
    expect(queue.snapshot().entries).toHaveLength(0);
  });

  // A blocked entry is a display state, exactly like waiting-blockers: it
  // reloads as `queued` so the next pump re-derives it from the live
  // environment rather than trusting a stale reason from a dead daemon.
  it('reloads a persisted blocked entry as queued', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const first = makeQueue(harness, stub.run);

    const stray = join(harness.rootDir, 'stray-download.zip');
    writeFileSync(stray, 'nope\n');
    first.enqueue(runId);
    await waitFor(
      () => first.snapshot().entries[0]?.state === 'blocked-environment'
    );

    // Environment fixed while the "daemon" was down, then a fresh queue over
    // the same rootDir picks the entry back up and merges it.
    rmSync(stray);
    const second = makeQueue(harness, stub.run);
    await waitFor(() => second.snapshot().history.length === 1);
    expect(second.snapshot().history[0].state).toBe('merged');
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
    const queue = makeQueue(harness, stub.run);

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
    const queue = makeQueue(harness, stub.run);

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

  // Regression for M3: nextEligible() used to look blockers up via a plain
  // (archived-excluded) cache.query(), so an archived-but-undone blocker
  // silently vanished from its lookup map and its dependent was treated as
  // unblocked. Archiving the blocker (without finishing it) must keep the
  // dependent parked at waiting-blockers, exactly like an unarchived one.
  it('keeps a dependent at waiting-blockers when its blocker is archived but undone', async () => {
    const harness = makeHarness();
    const { taskId: taskA } = await dispatchAndFinish(harness, 'Task A');
    harness.store.update(taskA, { archivedAt: new Date().toISOString() });

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
    const queue = makeQueue(harness, stub.run);

    queue.enqueue(runB);
    await waitFor(
      () =>
        queue.snapshot().entries.find((e) => e.runId === runB)?.state ===
        'waiting-blockers'
    );
    expect(stub.calls.length).toBe(0);
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
    const queue = makeQueue(harness, stub.run);

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
    const queue = makeQueue(harness, stub.run);

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
    const queue = makeQueue(harness, stub.run);
    expect(() => queue.enqueueStack(task.meta.id)).toThrow(
      OrchestratorConflictError
    );
  });

  it('persists enqueueStack entries across a fresh MergeQueue over the same rootDir', async () => {
    const harness = makeHarness();
    const { taskC, runB, runC } = await makeStack(harness);
    const stub = new StubRunner();
    const queue1 = makeQueue(harness, stub.run);
    queue1.enqueueStack(taskC);

    // A second MergeQueue over the exact same rootDir stands in for a daemon
    // restart — it must reload what queue1 just persisted synchronously via
    // broadcast()'s writeFileSync, not start from an empty queue.
    const queue2 = makeQueue(harness, stub.run);
    const runIds = queue2.snapshot().entries.map((e) => e.runId);
    expect(runIds).toContain(runB);
    expect(runIds).toContain(runC);
  });
});

describe('MergeQueue.enqueueReady', () => {
  it('queues every eligible run, stacked pairs in dependency order, and is idempotent', async () => {
    const harness = makeHarness();
    const { runId: runA } = await dispatchAndFinish(harness, 'independent');
    const { blockerRun, dependentRun } = await makeStackedPair(harness);
    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run);

    const entries = queue.enqueueReady();
    const ids = entries.map((e) => e.runId);
    expect(ids).toContain(runA);
    expect(ids.indexOf(blockerRun.id)).toBeLessThan(
      ids.indexOf(dependentRun.id)
    );
    // Already-queued runs are skipped silently on a second call.
    expect(queue.enqueueReady()).toEqual([]);
  });

  it('returns [] rather than throwing when nothing in the registry is eligible', () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run);
    expect(queue.enqueueReady()).toEqual([]);
  });

  // Regression: a task's status is user-settable (PATCH) independent of its
  // run's state, so a run left finished-and-unreviewed on a task the user
  // then cancels must not be swept into "merge everything ready" just
  // because the run itself still looks terminal-and-unreviewed.
  it('skips a finished unreviewed run whose task was since cancelled', async () => {
    const harness = makeHarness();
    const { runId, taskId } = await dispatchAndFinish(harness, 'cancel me');
    harness.store.update(taskId, { status: 'cancelled' });
    harness.cache.rebuild(harness.store);
    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run);

    expect(queue.enqueueReady()).toEqual([]);
    expect(queue.snapshot().entries.map((e) => e.runId)).not.toContain(runId);
  });

  // Regression: archivedAt is orthogonal to status — an archived-but-active
  // task's genuinely mergeable run must not be dropped just because
  // query()'s default (board-view) filter excludes archived tasks.
  it('includes a finished unreviewed run whose task is archived but still in-review', async () => {
    const harness = makeHarness();
    const { runId, taskId } = await dispatchAndFinish(harness, 'archived');
    harness.store.update(taskId, { archivedAt: new Date().toISOString() });
    harness.cache.rebuild(harness.store);
    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run);

    const entries = queue.enqueueReady();
    expect(entries.map((e) => e.runId)).toContain(runId);
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
    const queue = makeQueue(harness, stub.run);
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
    const queue = makeQueue(harness, stub.run);
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
    const queue = makeQueue(harness, stub.run);
    expect(() => queue.remove('r-nope')).toThrow(OrchestratorNotFoundError);
  });
});

describe('MergeQueue persistence', () => {
  it('reloads a queued entry into a freshly constructed MergeQueue over the same rootDir', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const queue1 = makeQueue(harness, stub.run);
    queue1.enqueue(runId);

    // A second MergeQueue over the exact same rootDir/orchestrator stands in
    // for a daemon restart: it must reload what queue1 just persisted rather
    // than starting from an empty queue. Everything above and below runs
    // synchronously with no `await` in between — pump() always yields on its
    // own `await Promise.resolve()` before touching any entry (see its
    // comment), so nothing has had a chance to advance this entry past
    // `queued` yet.
    const queue2 = makeQueue(harness, stub.run);
    const reloaded = queue2.snapshot().entries.find((e) => e.runId === runId);
    expect(reloaded?.state).toBe('queued');
  });

  it('requeues a mid-flight persisted entry instead of failing it, counting the attempt', async () => {
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
    const queue = makeQueue(harness, stub.run);

    // Retrying is safe for the same reason the old "re-enqueue to retry" advice
    // was: the rebase/verify/merge steps are idempotent against a half-done
    // prior attempt. So do it automatically rather than making a human notice.
    // Either it is still in line, or the retry already carried it to merged —
    // both mean it was not abandoned, which is what this asserts.
    await waitFor(
      () =>
        queue.snapshot().entries.some((e) => e.runId === runId) ||
        queue.snapshot().history.some((e) => e.runId === runId)
    );
    const filed = queue.snapshot().history.find((e) => e.runId === runId);
    // Not abandoned: it must not have been filed straight to failed history with
    // the old "re-enqueue to retry" reason.
    expect(filed?.state ?? 'merged').not.toBe('failed');
    expect(String(filed?.reason ?? '')).not.toContain(
      'daemon restarted mid-merge'
    );
    // And the retry was counted, so a recurring hang cannot loop forever.
    const seen =
      filed ?? queue.snapshot().entries.find((e) => e.runId === runId);
    expect(seen?.attempts).toBe(1);
  });

  // Auto-requeue plus a reproducible hang is an infinite loop: the daemon dies
  // mid-verify, boots, requeues, wedges again. The cap is the backstop for the
  // case a timeout cannot catch — the daemon being killed rather than the
  // command overrunning. `attempts` must therefore be PERSISTED; an in-memory
  // counter resets every boot, which is precisely the loop it exists to stop.
  it('abandons a mid-flight entry once it has burned through its attempts', async () => {
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
            state: 'merging',
            enqueuedAt: new Date().toISOString(),
            attempts: 3,
          },
        ],
        history: [],
      })
    );

    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run);

    const filed = queue.snapshot().history.find((e) => e.runId === runId);
    expect(filed?.state).toBe('failed');
    expect(filed?.reason).toMatch(/abandoned after 3/i);
    expect(
      queue.snapshot().entries.find((e) => e.runId === runId)
    ).toBeUndefined();
    // Still unreviewed — process() only reviews at the very end of merge(), so
    // a mid-flight death never got that far.
    expect(harness.orchestrator.getRun(runId)?.meta.reviewedAt).toBeUndefined();
  });

  it('persists the incremented attempt count so the cap survives a restart', async () => {
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
            state: 'merging',
            enqueuedAt: new Date().toISOString(),
            attempts: 1,
          },
        ],
        history: [],
      })
    );

    const stub = new StubRunner();
    // Rebase fails, so the entry stays put rather than merging and clearing —
    // leaving the persisted attempt count observable on disk.
    stub.rebaseResult = { ok: false, stdout: '', stderr: 'CONFLICT' };
    const queue = makeQueue(harness, stub.run);
    await waitFor(() => queue.snapshot().history.length === 1);

    const persisted = JSON.parse(
      readFileSync(mergeQueuePath(harness.rootDir), 'utf8')
    ) as { entries: { attempts?: number }[]; history: { attempts?: number }[] };
    const seen = [...persisted.entries, ...persisted.history].find(
      (e) => (e as { runId?: string }).runId === runId
    );
    expect(seen?.attempts).toBe(2);
  });

  it('starts with an empty queue when the persisted file is corrupt', () => {
    const harness = makeHarness();
    mkdirSync(runsDir(harness.rootDir), { recursive: true });
    writeFileSync(mergeQueuePath(harness.rootDir), '{not valid json');

    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run);
    expect(queue.snapshot()).toEqual({ entries: [], history: [] });
  });

  it('loads only one entry when the persisted file has two entries sharing a runId', async () => {
    const harness = makeHarness();
    const { runId, taskId } = await dispatchAndFinish(harness);
    mkdirSync(runsDir(harness.rootDir), { recursive: true });
    const persistedEntry = {
      runId,
      taskId,
      taskTitle: 'Ship it',
      state: 'queued',
      enqueuedAt: new Date().toISOString(),
    };
    // The persisted file is untrusted input — a bug or a manual edit could
    // duplicate the JSON entry for one run. hydrate() must reload the first
    // occurrence and file the second straight to failed history rather than
    // ending up with the same run queued twice.
    writeFileSync(
      mergeQueuePath(harness.rootDir),
      JSON.stringify({
        entries: [persistedEntry, { ...persistedEntry }],
        history: [],
      })
    );

    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run);

    const loaded = queue.snapshot().entries.filter((e) => e.runId === runId);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.state).toBe('queued');

    const filed = queue.snapshot().history.filter((e) => e.runId === runId);
    expect(filed).toHaveLength(1);
    expect(filed[0]?.reason).toContain('duplicate entry for run');
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
    const queue = makeQueue(harness, stub.run);

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
    const queue = makeQueue(harness, noJjRunner);

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
    const queue = makeQueue(harness, noJjRunner);
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
    const queue = makeQueue(harness, noJjRunner);
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
    const queue = makeQueue(harness, run);
    const tipBefore = runGitSync(harness.rootDir, [
      'rev-parse',
      dependentRun.branch,
    ]).trim();
    // Both jj destinations are pinned to an exact commit, so a regression that
    // rebased onto the WRONG commit could not slip through a looser shape
    // check. The two are different commits and both have to be captured at the
    // right moment: the entry's own `-b` rebase runs BEFORE the squash-merge,
    // against main's tip as it stands now; the dependent's `-s` restack runs
    // after, against the squash commit.
    const mainShaBeforeMerge = runGitSync(harness.rootDir, [
      'rev-parse',
      'main',
    ]).trim();

    queue.enqueue(blockerRun.id);
    await waitFor(() =>
      queue.snapshot().history.some((e) => e.state === 'merged')
    );

    // Destinations are always plain commit ids, never ref names: jj cannot
    // resolve git's `origin/<base>` spelling at all, so every jj destination
    // goes through `git rev-parse` first (see MergeQueue.jjRevision).
    const mainShaAfterMerge = runGitSync(harness.rootDir, [
      'rev-parse',
      'main',
    ]).trim();
    expect(mainShaAfterMerge).not.toBe(mainShaBeforeMerge);
    // The entry's own rebase goes through jj too, so descendants follow it.
    expect(jjCalls).toContainEqual([
      'jj',
      'rebase',
      '-b',
      blockerRun.branch,
      '-d',
      mainShaBeforeMerge,
    ]);
    // The dependent is restacked with -s over ONLY its own commits, never -b
    // over the whole branch.
    expect(jjCalls).toContainEqual([
      'jj',
      'rebase',
      '-s',
      `roots(${dependentRun.stackBaseCommit ?? ''}..${dependentRun.branch})`,
      '-d',
      mainShaAfterMerge,
      '--skip-emptied',
    ]);
    // No jj destination may be a ref name — that is exactly the bug this
    // guards: `jj rebase -d origin/main` fails outright on jj 0.43.
    for (const call of jjCalls) {
      const dIdx = call.indexOf('-d');
      if (dIdx === -1) continue;
      expect(call[dIdx + 1]).toMatch(/^[0-9a-f]{40}$/);
    }
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

    const queue = makeQueue(harness, noJjRunner);
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

    const queue = makeQueue(harness, noJjRunner);
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
    const queue = makeQueue(harness, runner);

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
    const queue = makeQueue(harness, runner);

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
    const queue = makeQueue(harness, noJjRunner);

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

    const queue = makeQueue(harness, noJjRunner);
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
    const queue2 = makeQueue(harness, noJjRunner);
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

    const queue = makeQueue(harness, noJjRunner);
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

    const queue = makeQueue(harness, noJjRunner);
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

// `requestChanges` starts a NEW run in the SAME worktree on the SAME branch as
// the run it resumes. That is the one shape where "this run is terminal" and
// "nothing is using this worktree" come apart, and every restack guard used to
// be written in terms of the former.
describe('MergeQueue and a request-changes run sharing a worktree', () => {
  // Puts a live resumed run into the dependent's worktree: the original run
  // stays `finished` forever while its replacement's agent works in the same
  // directory, on the same branch.
  async function resumeDependent(
    harness: Harness,
    dependentRun: RunMeta
  ): Promise<RunMeta> {
    // requestChanges resolves the ORIGINAL run's executor name, so replacing
    // what 'fake' points at is what makes the resumed run stay live.
    harness.orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          { approval: { requestId: 'gate', toolName: 'noop', input: {} } },
        ],
        finish: { state: 'finished', costUsd: 0, turns: 1 },
      })
    );
    const resumed = harness.orchestrator.sendMessage(
      dependentRun.id,
      'please tweak it',
      { resume: true }
    );
    await waitFor(
      () =>
        harness.orchestrator.getRun(resumed.id)?.meta.state ===
        'awaiting-approval'
    );
    return harness.orchestrator.list().find((r) => r.id === resumed.id)!;
  }

  it('carries the stacking facts onto the resumed run', async () => {
    const harness = makeHarness();
    const { blockerRun, dependentRun } = await makeStackedPair(harness);
    const resumed = await resumeDependent(harness, dependentRun);

    // Without these the resumed run — the one that will actually be merged —
    // is invisible to the merge queue: never restacked, never flagged, and
    // stranded on a branch that gets deleted when the blocker lands.
    expect(resumed.branch).toBe(dependentRun.branch);
    expect(resumed.worktreePath).toBe(dependentRun.worktreePath);
    expect(resumed.stackParents).toEqual([blockerRun.branch]);
    expect(resumed.stackBaseCommit).toBe(dependentRun.stackBaseCommit);
  });

  it('never rewrites the shared worktree while the resumed run is live, and restacks both once it finishes', async () => {
    const harness = makeHarness();
    const { blockerRun, dependentRun } = await makeStackedPair(harness);
    const resumed = await resumeDependent(harness, dependentRun);
    const tipBefore = runGitSync(harness.rootDir, [
      'rev-parse',
      dependentRun.branch,
    ]).trim();
    // Content the live agent is "working on", to prove nothing hard-reset the
    // worktree out from under it.
    writeFileSync(join(dependentRun.worktreePath, 'in-flight.txt'), 'wip\n');

    const queue = makeQueue(harness, noJjRunner);
    queue.enqueue(blockerRun.id);
    await waitFor(() =>
      queue.snapshot().history.some((e) => e.state === 'merged')
    );

    // The blocker really merged, and the branch the live agent is on was left
    // exactly alone — no rebase, no checkout, no hard reset.
    expect(
      runGitSync(harness.rootDir, ['rev-parse', dependentRun.branch]).trim()
    ).toBe(tipBefore);
    expect(
      await Bun.file(join(dependentRun.worktreePath, 'in-flight.txt')).exists()
    ).toBe(true);
    // ...and neither run was flagged: nothing is wrong, it just isn't safe yet.
    for (const id of [dependentRun.id, resumed.id]) {
      expect(
        harness.orchestrator.list().find((r) => r.id === id)?.baseDiscarded
      ).toBeUndefined();
    }

    // Releasing the agent is what makes the worktree safe to touch.
    runGitSync(dependentRun.worktreePath, ['add', 'in-flight.txt']);
    runGitSync(dependentRun.worktreePath, ['commit', '-m', 'in flight']);
    harness.orchestrator.approve(resumed.id, 'gate', true);
    await waitFor(
      () => harness.orchestrator.getRun(resumed.id)?.meta.state === 'finished'
    );
    await waitFor(
      () =>
        harness.orchestrator.list().find((r) => r.id === resumed.id)
          ?.baseBranch === 'main'
    );

    // Both runs on that branch are repointed — leaving the sibling behind
    // would have it name the merged blocker as a stack parent still, and the
    // next sweep would rebase the same branch a second time.
    for (const id of [dependentRun.id, resumed.id]) {
      const meta = harness.orchestrator.list().find((r) => r.id === id)!;
      expect(meta.baseBranch).toBe('main');
      expect(meta.stackParents).toBeUndefined();
      expect(meta.baseDiscarded).toBeUndefined();
    }
    // The blocker's squashed work arrived, and the agent's in-flight commit
    // survived the restack.
    expect(
      await Bun.file(join(dependentRun.worktreePath, 'a.txt')).exists()
    ).toBe(true);
    expect(
      await Bun.file(join(dependentRun.worktreePath, 'in-flight.txt')).exists()
    ).toBe(true);
  });
});

describe('MergeQueue and a dependent whose blocker was discarded mid-run', () => {
  // Orchestrator.review's discard branch deliberately skips a dependent whose
  // worktree still has a live run in it. Something has to come back to it, or
  // the flag is simply lost: this is that something, and it is the same sweep
  // that handles "your blocker merged".
  it('flags it once its worktree goes quiet, not while its agent is working', async () => {
    const harness = makeHarness();
    const { runId: runA, taskId: taskA } = await dispatchAndFinish(
      harness,
      'Task A'
    );
    const blockerRun = harness.orchestrator.list().find((r) => r.id === runA)!;
    commitFile(blockerRun.worktreePath, 'a.txt', 'A work');

    harness.orchestrator.registerExecutor(
      'gated',
      new FakeExecutor({
        steps: [
          { approval: { requestId: 'gate', toolName: 'noop', input: {} } },
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

    const queue = makeQueue(harness, noJjRunner);
    harness.orchestrator.review(runA, 'discard');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      harness.orchestrator.list().find((r) => r.id === metaB.id)?.baseDiscarded
    ).toBeUndefined();

    harness.orchestrator.approve(metaB.id, 'gate', true);
    await waitFor(
      () => harness.orchestrator.getRun(metaB.id)?.meta.state === 'finished'
    );
    await waitFor(
      () =>
        harness.orchestrator.list().find((r) => r.id === metaB.id)
          ?.baseDiscarded === true
    );
    const flagged = harness.orchestrator.list().find((r) => r.id === metaB.id)!;
    expect(flagged.baseDiscardedReason).toContain('was discarded');
    expect(harness.store.get(taskB.meta.id)?.body ?? '').toContain(
      'was discarded'
    );
    // And nothing was rewritten — the base was rejected, not moved.
    expect(flagged.baseBranch).toBe(blockerRun.branch);
    expect(queue.snapshot().entries).toHaveLength(0);
  });
});

describe('MergeQueue restack persistence across a restart', () => {
  // A restack narrows `stackParents` at the same moment it rewrites
  // `baseBranch`. Persisting only the base means a replayed run pairs the NEW
  // base with the ORIGINAL parent list — at which point the boot sweep
  // re-derives an already-merged blocker, decides the run sits on an
  // unrepairable multi-parent base, and flags a perfectly healthy run
  // `baseDiscarded` forever (nothing ever clears it).
  it('replays a restacked dependent as restacked, and a reboot does not flag it', async () => {
    const harness = makeHarness();
    const { blockerRun, dependentRun } = await makeStackedPair(harness);
    const queue = makeQueue(harness, noJjRunner);
    queue.enqueue(blockerRun.id);
    await waitFor(() =>
      queue.snapshot().history.some((e) => e.state === 'merged')
    );

    const replayed = replayTranscript(
      transcriptPath(harness.rootDir, dependentRun.id)
    );
    expect(replayed?.meta.baseBranch).toBe('main');
    expect(replayed?.meta.stackParents).toBeUndefined();

    // The real restart: a fresh Orchestrator hydrated purely from transcripts,
    // and a fresh MergeQueue whose constructor sweeps every inherited run.
    const rebooted = new Orchestrator({
      rootDir: harness.rootDir,
      store: harness.store,
      cache: harness.cache,
      events: harness.events,
    });
    rebooted.reconcileOnBoot();
    expect(
      rebooted.list().find((r) => r.id === dependentRun.id)?.stackParents
    ).toBeUndefined();
    const bootQueue = makeQueue(
      { ...harness, orchestrator: rebooted },
      noJjRunner
    );
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(bootQueue.snapshot().entries).toHaveLength(0);
    const afterBoot = rebooted.list().find((r) => r.id === dependentRun.id)!;
    expect(afterBoot.baseDiscarded).toBeUndefined();
    expect(afterBoot.baseBranch).toBe('main');
    expect(harness.store.get(dependentRun.taskId)?.body ?? '').not.toContain(
      'multi-parent base'
    );
  });
});

describe('MergeQueue backup ref cleanup', () => {
  // Every restack writes a backup ref. Merging or discarding deletes the
  // branch and the worktree but used to leave the backup, pinning the
  // pre-restack commit graph forever and growing the ref store without bound.
  it('prunes a run backup refs when its worktree is removed', async () => {
    const harness = makeHarness();
    const { blockerRun, dependentRun } = await makeStackedPair(harness);
    const queue = makeQueue(harness, noJjRunner);
    queue.enqueue(blockerRun.id);
    await waitFor(() =>
      queue.snapshot().history.some((e) => e.state === 'merged')
    );

    const backupsAfterRestack = runGitSync(harness.rootDir, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/dispatch/backup',
    ]);
    expect(backupsAfterRestack).toContain(dependentRun.id);

    harness.orchestrator.review(dependentRun.id, 'discard');
    expect(
      runGitSync(harness.rootDir, [
        'for-each-ref',
        '--format=%(refname)',
        'refs/dispatch/backup',
      ]).trim()
    ).toBe('');
  });
});

// The blind spot the stubbed jj tests have by construction: they answer every
// jj command `ok` and move nothing, so "the dependent's tip is unchanged"
// passes precisely because nothing happened. These run real jj against a real
// colocated repo.
describe('MergeQueue against real jj', () => {
  it.skipIf(!hasJj())(
    'restacks a dependent onto the new base, replaying only its own commits',
    async () => {
      const harness = makeHarness();
      colocate(harness.rootDir);
      const { blockerRun, dependentRun } = await makeStackedPair(harness);
      const tipBefore = runGitSync(harness.rootDir, [
        'rev-parse',
        dependentRun.branch,
      ]).trim();

      const queue = makeQueue(harness, defaultCommandRunner);
      queue.enqueue(blockerRun.id);
      await waitFor(() =>
        queue.snapshot().history.some((e) => e.state === 'merged')
      );
      expect(queue.snapshot().history[0].reason).toBeUndefined();

      await waitFor(
        () =>
          harness.orchestrator.list().find((r) => r.id === dependentRun.id)
            ?.baseBranch === 'main'
      );
      const updated = harness.orchestrator
        .list()
        .find((r) => r.id === dependentRun.id)!;
      expect(updated.baseDiscarded).toBeUndefined();
      expect(
        runGitSync(harness.rootDir, ['rev-parse', dependentRun.branch]).trim()
      ).not.toBe(tipBefore);

      // The worktree must be back ON its branch — jj leaves a rewritten
      // branch's worktree DETACHED at the old commit, with a clean
      // `git status`, so nothing but this assertion notices.
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
      // The blocker's work arrives once, via the squash — never replayed on
      // top of its own squashed copy.
      expect(
        runGitSync(dependentRun.worktreePath, [
          'log',
          '--oneline',
          '--',
          'a.txt',
        ])
          .split('\n')
          .filter((l) => l.trim().length > 0)
      ).toHaveLength(1);
    }
  );

  // I2: `origin/<base>` is not a jj revset at all — measured on jj 0.43.0,
  // `jj rebase -b feat -d origin/main` fails with "Revision `origin/main`
  // doesn't exist". Both jj destinations in the PR flow are that exact shape,
  // so before they were resolved to commit ids this threw every time: the
  // entry failed permanently, and the dependent got a sticky `baseDiscarded`.
  it.skipIf(!hasJj())(
    'restacks onto a PR-merged base, whose jj destination is a remote-tracking ref',
    async () => {
      const harness = makeHarness();
      const remote = mkdtempSync(join(tmpdir(), 'dispatch-remote-'));
      runGitSync(remote, ['init', '--bare', '-b', 'main']);
      runGitSync(harness.rootDir, ['remote', 'add', 'origin', remote]);
      runGitSync(harness.rootDir, ['push', '-u', 'origin', 'main']);
      colocate(harness.rootDir);

      const { blockerRun, dependentRun } = await makeStackedPair(harness);
      harness.orchestrator.setRunPrUrl(
        blockerRun.id,
        'https://github.com/example/repo/pull/1'
      );

      // Everything real except `gh`, which stands in for GitHub landing the
      // PR: the blocker's work appears on the REMOTE main while the local main
      // stays exactly where it was.
      const runner: CommandRunner = async (cwd, cmd) => {
        if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'merge') {
          runGitSync(harness.rootDir, [
            'push',
            'origin',
            `${blockerRun.branch}:main`,
          ]);
          runGitSync(harness.rootDir, [
            'update-ref',
            '-d',
            'refs/remotes/origin/main',
          ]);
          return { ok: true, stdout: '', stderr: '' };
        }
        return defaultCommandRunner(cwd, cmd);
      };
      const queue = makeQueue(harness, runner);

      queue.enqueue(blockerRun.id);
      await waitFor(() =>
        queue.snapshot().history.some((e) => e.state === 'merged')
      );
      expect(queue.snapshot().history[0].reason).toBeUndefined();

      await waitFor(
        () =>
          harness.orchestrator.list().find((r) => r.id === dependentRun.id)
            ?.baseBranch === 'main'
      );
      const updated = harness.orchestrator
        .list()
        .find((r) => r.id === dependentRun.id)!;
      expect(updated.baseDiscarded).toBeUndefined();
      // The blocker's work is present even though the LOCAL main knows nothing
      // about it — proof the restack really targeted the remote base.
      expect(
        await Bun.file(join(dependentRun.worktreePath, 'a.txt')).exists()
      ).toBe(true);
      expect(await Bun.file(join(harness.rootDir, 'a.txt')).exists()).toBe(
        false
      );

      rmSync(remote, { recursive: true, force: true });
    }
  );

  // C2: `jj rebase -b` rewrites descendants and moves their bookmarks. A
  // descendant branch checked out in a git worktree is left DETACHED at its old
  // commit with a CLEAN `git status` (measured, jj 0.43.0) — the run's state
  // hasn't changed, the worktree isn't dirty, and the restack paths correctly
  // skip it as live, so absolutely nothing notices. Its agent then commits onto
  // a detached HEAD and every one of those commits is silently dropped when the
  // branch is later squash-merged.
  it.skipIf(!hasJj())(
    'rebases with plain git while a dependent is live, so jj never detaches its worktree',
    async () => {
      const harness = makeHarness();
      colocate(harness.rootDir);
      const { runId: runA, taskId: taskA } = await dispatchAndFinish(
        harness,
        'Task A'
      );
      const blockerRun = harness.orchestrator
        .list()
        .find((r) => r.id === runA)!;
      commitFile(blockerRun.worktreePath, 'a.txt', 'A work');

      harness.orchestrator.registerExecutor(
        'gated',
        new FakeExecutor({
          steps: [
            { approval: { requestId: 'gate', toolName: 'noop', input: {} } },
          ],
          finish: { state: 'finished', costUsd: 0, turns: 1 },
        })
      );
      const taskB = harness.store.create({
        title: 'Task B',
        blockedBy: [taskA],
      });
      const metaB = await harness.orchestrator.dispatch(taskB.meta.id, 'gated');
      await waitFor(
        () =>
          harness.orchestrator.getRun(metaB.id)?.meta.state ===
          'awaiting-approval'
      );
      const dependent = harness.orchestrator
        .list()
        .find((r) => r.id === metaB.id)!;

      // main has to have moved, or the blocker's rebase is a no-op and jj
      // would rewrite nothing whichever path ran.
      writeFileSync(join(harness.rootDir, 'late.txt'), 'landed on main\n');
      runGitSync(harness.rootDir, ['add', 'late.txt']);
      runGitSync(harness.rootDir, ['commit', '-m', 'late main commit']);

      const dependentTip = runGitSync(harness.rootDir, [
        'rev-parse',
        dependent.branch,
      ]).trim();

      const queue = makeQueue(harness, defaultCommandRunner);
      queue.enqueue(runA);
      await waitFor(() =>
        queue.snapshot().history.some((e) => e.state === 'merged')
      );

      // The live dependent is untouched: same tip, still ATTACHED to its own
      // branch. Under the jj path both of those would be false.
      expect(
        runGitSync(harness.rootDir, ['rev-parse', dependent.branch]).trim()
      ).toBe(dependentTip);
      expect(
        runGitSync(dependent.worktreePath, [
          'rev-parse',
          '--abbrev-ref',
          'HEAD',
        ]).trim()
      ).toBe(dependent.branch);
      // A commit the agent makes now must land on the branch, not on a
      // detached HEAD.
      commitFile(dependent.worktreePath, 'b.txt', 'B work');
      expect(
        runGitSync(harness.rootDir, ['rev-parse', dependent.branch]).trim()
      ).toBe(runGitSync(dependent.worktreePath, ['rev-parse', 'HEAD']).trim());
      // ...and the choice of path is on the record, not just in a comment.
      expect(harness.store.get(taskA)?.body ?? '').toContain(
        'rebased with plain git rather than jj'
      );

      // The dependent is then restacked normally once it goes terminal.
      harness.orchestrator.approve(metaB.id, 'gate', true);
      await waitFor(
        () => harness.orchestrator.getRun(metaB.id)?.meta.state === 'finished'
      );
      await waitFor(
        () =>
          harness.orchestrator.list().find((r) => r.id === metaB.id)
            ?.baseBranch === 'main'
      );
      expect(
        await Bun.file(join(dependent.worktreePath, 'a.txt')).exists()
      ).toBe(true);
      expect(
        await Bun.file(join(dependent.worktreePath, 'b.txt')).exists()
      ).toBe(true);
    }
  );

  // The same hazard one level further out, which is the shape stacked dispatch
  // actually exists to serve. A blocks B blocks C: because an `in-review`
  // blocker counts as satisfied for dispatch, B is branched off A's branch and
  // C off B's, so C's branch is a git DESCENDANT of A's — but C records only
  // `['dispatch/B…']` in `stackParents` and never names A at all.
  //
  // `jj rebase -b <A>` rewrites A's, B's AND C's commits and moves C's
  // bookmark, so a gate that tests direct `stackParents` membership returns
  // false, takes the jj path, and detaches live C exactly as Probe 1 showed —
  // one level up, where nothing is watching. Asking git which branches contain
  // A answers this at any depth.
  it.skipIf(!hasJj())(
    'rebases with plain git when a live run sits two levels above, not just one',
    async () => {
      const harness = makeHarness();
      colocate(harness.rootDir);

      // A: blocker, terminal and unreviewed, with real content.
      const { runId: runA, taskId: taskA } = await dispatchAndFinish(
        harness,
        'Task A'
      );
      const branchA = harness.orchestrator.list().find((r) => r.id === runA)!;
      commitFile(branchA.worktreePath, 'a.txt', 'A work');

      // B: blocked by A, so branched off A's branch. Also terminal.
      const taskB = harness.store.create({
        title: 'Task B',
        blockedBy: [taskA],
      });
      const metaB = await harness.orchestrator.dispatch(taskB.meta.id, 'fake');
      await waitFor(
        () => harness.orchestrator.getRun(metaB.id)?.meta.state === 'finished'
      );
      const branchB = harness.orchestrator
        .list()
        .find((r) => r.id === metaB.id)!;
      expect(branchB.baseBranch).toBe(branchA.branch);
      commitFile(branchB.worktreePath, 'b.txt', 'B work');

      // C: blocked by B, so branched off B's branch — and still LIVE.
      harness.orchestrator.registerExecutor(
        'gated',
        new FakeExecutor({
          steps: [
            { approval: { requestId: 'gate', toolName: 'noop', input: {} } },
          ],
          finish: { state: 'finished', costUsd: 0, turns: 1 },
        })
      );
      const taskC = harness.store.create({
        title: 'Task C',
        blockedBy: [taskB.meta.id],
      });
      const metaC = await harness.orchestrator.dispatch(taskC.meta.id, 'gated');
      await waitFor(
        () =>
          harness.orchestrator.getRun(metaC.id)?.meta.state ===
          'awaiting-approval'
      );
      const liveC = harness.orchestrator.list().find((r) => r.id === metaC.id)!;

      // The exact shape the one-link gate is blind to: C is a git descendant
      // of A, but nothing C records mentions A.
      expect(liveC.baseBranch).toBe(branchB.branch);
      expect(liveC.stackParents).toEqual([branchB.branch]);
      expect(liveC.stackParents).not.toContain(branchA.branch);
      expect(
        Bun.spawnSync(
          ['git', 'merge-base', '--is-ancestor', branchA.branch, liveC.branch],
          { cwd: harness.rootDir, stdout: 'pipe', stderr: 'pipe' }
        ).exitCode
      ).toBe(0);

      // main has to have moved, or A's rebase is a no-op and jj rewrites
      // nothing whichever path ran.
      writeFileSync(join(harness.rootDir, 'late.txt'), 'landed on main\n');
      runGitSync(harness.rootDir, ['add', 'late.txt']);
      runGitSync(harness.rootDir, ['commit', '-m', 'late main commit']);

      const tipC = runGitSync(harness.rootDir, [
        'rev-parse',
        liveC.branch,
      ]).trim();

      const queue = makeQueue(harness, defaultCommandRunner);
      queue.enqueue(runA);
      await waitFor(() =>
        queue.snapshot().history.some((e) => e.state === 'merged')
      );

      // Live C, two levels up, is untouched and still ATTACHED.
      expect(
        runGitSync(harness.rootDir, ['rev-parse', liveC.branch]).trim()
      ).toBe(tipC);
      expect(
        runGitSync(liveC.worktreePath, [
          'rev-parse',
          '--abbrev-ref',
          'HEAD',
        ]).trim()
      ).toBe(liveC.branch);
      // The load-bearing consequence: a commit C's agent makes after the merge
      // reaches refs/heads/<C> instead of vanishing onto a detached HEAD.
      commitFile(liveC.worktreePath, 'c.txt', 'C work');
      expect(
        runGitSync(harness.rootDir, ['rev-parse', liveC.branch]).trim()
      ).toBe(runGitSync(liveC.worktreePath, ['rev-parse', 'HEAD']).trim());
      expect(harness.store.get(taskA)?.body ?? '').toContain(
        'rebased with plain git rather than jj'
      );

      // The same gate must hold for the post-merge restack of B, whose jj form
      // (`jj rebase -s`) also carries descendants: B moves, C does not.
      await waitFor(
        () =>
          harness.orchestrator.list().find((r) => r.id === metaB.id)
            ?.baseBranch === 'main'
      );
      expect(
        runGitSync(liveC.worktreePath, [
          'rev-parse',
          '--abbrev-ref',
          'HEAD',
        ]).trim()
      ).toBe(liveC.branch);
      expect(
        runGitSync(harness.rootDir, ['rev-parse', liveC.branch]).trim()
      ).toBe(runGitSync(liveC.worktreePath, ['rev-parse', 'HEAD']).trim());
    }
  );
});
