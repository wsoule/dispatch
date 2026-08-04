import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { LedgerStore } from '../../src/ledger.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { MergeQueue } from '../../src/orchestrator/mergeQueue.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import type { CommandResult } from '../../src/orchestrator/pr.js';
import { QuestionRegistry } from '../../src/orchestrator/questions.js';
import type { WardenToolContext } from '../../src/orchestrator/wardenTools.js';
import {
  WARDEN_MUTATING_TOOLS,
  WARDEN_STATUS_TOOLS,
  WardenToolError,
  WardenToolRegistry,
} from '../../src/orchestrator/wardenTools.js';
import { initGitRepo } from './helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

// Every queue a test builds, so afterEach can stop its timers — a
// 'blocked-environment' entry arms a self-retry that would otherwise fire long
// after the test ended, writing into a fakeHome that no longer exists.
const liveQueues: MergeQueue[] = [];
// Same problem from the other direction: the 'slow' executor holds a run open
// for a minute, and a run still running when its test ends would finish during
// some LATER test and write its transcript against whatever DISPATCH_HOME is
// set then. Cancelling here interrupts the scripted delay immediately.
const liveOrchestrators: Orchestrator[] = [];

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-warden-');
});

afterEach(async () => {
  for (const queue of liveQueues) queue.stop();
  liveQueues.length = 0;
  for (const orchestrator of liveOrchestrators) {
    for (const meta of orchestrator.list()) {
      // Racing a run that reached a terminal state on its own is expected, not
      // a teardown failure — cancel() throws a conflict for those.
      await orchestrator.cancel(meta.id).catch(() => {});
    }
  }
  liveOrchestrators.length = 0;
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

// Gives an effect that leaked out of `describe` time to land before a
// "nothing happened" assertion runs. Without it those assertions read the
// world synchronously, one microtask before an un-awaited `apply()` could
// have done anything — so they would pass even if the effect were firing.
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

// Answers exactly the git/gh invocations the merge queue makes, so no test
// here depends on a real rebase/verify/push. Copied in shape from
// merge-queue.test.ts's StubRunner, including its `ok: false` default for
// anything unrecognised: a runner that blanket-succeeds makes the queue think
// jj is available and take a revision-resolving path that then fails on the
// empty stdout. The queue's own mechanics are merge-queue.test.ts's subject;
// these tests only need entries that exist and settle predictably.
const stubRunner = async (
  _cwd: string,
  cmd: string[]
): Promise<CommandResult> => {
  const ok = { ok: true, stdout: '', stderr: '' };
  if (cmd[0] === 'git' && cmd[1] === 'fetch') return ok;
  if (cmd[0] === 'git' && cmd[1] === 'rebase') return ok;
  if (cmd[0] === 'bash' && cmd[1] === '-lc') return ok;
  if (cmd[0] === 'git' && cmd[1] === 'push') return ok;
  return { ok: false, stdout: '', stderr: 'unhandled stub command' };
};

interface Harness extends WardenToolContext {
  registry: WardenToolRegistry;
}

/**
 * A whole project's worth of wiring, assembled the same way index.ts does it
 * but over a throwaway git repo. Three executors are registered because the
 * mutating tools need runs in three different shapes: one that finishes
 * immediately, one that stays live long enough to be cancelled or messaged,
 * and one that parks on an approval gate.
 */
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
  liveOrchestrators.push(orchestrator);
  orchestrator.registerExecutor(
    'fake',
    new FakeExecutor({
      finish: { state: 'finished', costUsd: 0, turns: 1, sessionId: 'sess-1' },
    })
  );
  orchestrator.registerExecutor(
    'slow',
    new FakeExecutor({
      steps: [{ delayMs: 60_000 }],
      finish: { state: 'finished', sessionId: 'sess-2' },
    })
  );
  orchestrator.registerExecutor(
    'gated',
    new FakeExecutor({
      steps: [
        {
          approval: {
            requestId: 'req-1',
            toolName: 'Bash',
            input: { command: 'rm -rf /' },
          },
        },
      ],
      finish: { state: 'finished', sessionId: 'sess-3' },
    })
  );
  const mergeQueue = new MergeQueue(
    { rootDir: repo, store, cache, events, orchestrator },
    stubRunner
  );
  liveQueues.push(mergeQueue);
  const questions = new QuestionRegistry();
  const ledgerStore = new LedgerStore(repo);
  const ctx: WardenToolContext = {
    store,
    cache,
    orchestrator,
    mergeQueue,
    questions,
    ledgerStore,
    defaultExecutor: 'fake',
  };
  return { ...ctx, registry: new WardenToolRegistry(ctx) };
}

/** Dispatches `title` on `executor` and returns once the run has settled into `state`. */
async function dispatchUntil(
  h: Harness,
  title: string,
  executor: string,
  state: string
): Promise<{ runId: string; taskId: string }> {
  const task = h.store.create({ title });
  h.cache.rebuild(h.store);
  const meta = await h.orchestrator.dispatch(task.meta.id, executor);
  await waitFor(() => h.orchestrator.getRun(meta.id)?.meta.state === state);
  return { runId: meta.id, taskId: task.meta.id };
}

// ---------------------------------------------------------------------------
// Tool set shape
// ---------------------------------------------------------------------------

describe('warden tool sets', () => {
  it('exposes both sets with unique names and no overlap between them', () => {
    const h = makeHarness();
    const statusNames = h.registry.statusTools().map((t) => t.name);
    const mutatingNames = h.registry.mutatingTools().map((t) => t.name);

    expect(new Set(statusNames).size).toBe(statusNames.length);
    expect(new Set(mutatingNames).size).toBe(mutatingNames.length);
    // A name in both sets would make "is this call safe to run without asking"
    // ambiguous at the exact moment it matters most.
    for (const name of mutatingNames) expect(statusNames).not.toContain(name);
  });

  it('covers every status and mutating tool the warden is specified to have', () => {
    expect(WARDEN_STATUS_TOOLS.map((t) => t.name).sort()).toEqual([
      'ledger_entries',
      'list_blocked_tasks',
      'list_ready_tasks',
      'list_runs',
      'merge_queue',
      'open_questions',
      'pending_approvals',
    ]);
    expect(WARDEN_MUTATING_TOOLS.map((t) => t.name).sort()).toEqual([
      'approve_run',
      'cancel_run',
      'deny_run',
      'dequeue_merge',
      'dispatch_task',
      'message_run',
    ]);
  });

  it('rejects an unknown tool name on both call paths', () => {
    const h = makeHarness();
    expect(() => h.registry.callStatusTool('list_everything')).toThrow(
      WardenToolError
    );
    expect(() => h.registry.callMutatingTool('delete_everything')).toThrow(
      WardenToolError
    );
  });

  it('restates a schema failure as a readable message instead of a ZodError', () => {
    const h = makeHarness();
    expect(() => h.registry.callStatusTool('list_runs', { limit: -1 })).toThrow(
      /invalid input for list_runs: limit/
    );
    // A missing required field, which is the shape a model actually gets wrong.
    expect(() => h.registry.callMutatingTool('cancel_run', {})).toThrow(
      /invalid input for cancel_run: runId/
    );
  });
});

// ---------------------------------------------------------------------------
// Status tools
// ---------------------------------------------------------------------------

describe('warden status tools', () => {
  it('list_runs shows live runs, and terminal ones only when asked', async () => {
    const h = makeHarness();
    const { runId, taskId } = await dispatchUntil(
      h,
      'Done',
      'fake',
      'finished'
    );

    const live = h.registry.callStatusTool('list_runs') as {
      runs: unknown[];
      total: number;
    };
    expect(live.total).toBe(0);

    const all = h.registry.callStatusTool('list_runs', {
      includeTerminal: true,
    }) as { runs: Record<string, unknown>[]; total: number };
    expect(all.total).toBe(1);
    expect(all.runs[0]).toMatchObject({
      id: runId,
      taskId,
      taskTitle: 'Done',
      state: 'finished',
      live: false,
      reviewedAt: null,
    });
  });

  it('list_runs caps the returned rows at `limit` while still reporting the true total', async () => {
    const h = makeHarness();
    await dispatchUntil(h, 'One', 'fake', 'finished');
    await dispatchUntil(h, 'Two', 'fake', 'finished');

    const capped = h.registry.callStatusTool('list_runs', {
      includeTerminal: true,
      limit: 1,
    }) as { runs: unknown[]; total: number };
    expect(capped.runs).toHaveLength(1);
    expect(capped.total).toBe(2);
  });

  it('list_ready_tasks returns unblocked tasks as summaries without bodies', () => {
    const h = makeHarness();
    h.store.create({ title: 'Ready one', description: 'a long body' });
    h.cache.rebuild(h.store);

    const result = h.registry.callStatusTool('list_ready_tasks') as {
      tasks: Record<string, unknown>[];
      total: number;
    };
    expect(result.total).toBe(1);
    expect(result.tasks[0]).toMatchObject({ title: 'Ready one' });
    expect(result.tasks[0]).not.toHaveProperty('body');
  });

  it('list_blocked_tasks reports only blockers that are still open', () => {
    const h = makeHarness();
    const open = h.store.create({ title: 'Blocker still open' });
    const closed = h.store.create({ title: 'Blocker already done' });
    h.store.update(closed.meta.id, { status: 'done' });
    const blocked = h.store.create({
      title: 'Waiting',
      blockedBy: [open.meta.id, closed.meta.id, 't-ghost0'],
    });
    h.cache.rebuild(h.store);

    const result = h.registry.callStatusTool('list_blocked_tasks') as {
      tasks: { id: string; blockedByOpen: string[] }[];
      total: number;
    };
    expect(result.total).toBe(1);
    expect(result.tasks[0].id).toBe(blocked.meta.id);
    // The done blocker and the dangling id are both filtered out — only the
    // one actually holding this task up is reported.
    expect(result.tasks[0].blockedByOpen).toEqual([open.meta.id]);
  });

  it('merge_queue reports queued entries and merged history', async () => {
    const h = makeHarness();
    const { runId } = await dispatchUntil(h, 'Mergeable', 'fake', 'finished');
    h.mergeQueue.enqueue(runId);

    await waitFor(() => h.mergeQueue.snapshot().history.length === 1);
    const result = h.registry.callStatusTool('merge_queue') as {
      entries: unknown[];
      history: Record<string, unknown>[];
    };
    expect(result.entries).toHaveLength(0);
    expect(result.history[0]).toMatchObject({
      runId,
      taskTitle: 'Mergeable',
      state: 'merged',
    });
  });

  it('pending_approvals names the tool call a run is parked on', async () => {
    const h = makeHarness();
    const { runId } = await dispatchUntil(
      h,
      'Gated',
      'gated',
      'awaiting-approval'
    );

    const result = h.registry.callStatusTool('pending_approvals') as {
      approvals: Record<string, unknown>[];
      total: number;
    };
    expect(result.total).toBe(1);
    expect(result.approvals[0]).toMatchObject({
      runId,
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
    });
  });

  // The registry only clears a run's pending approval when approve() answers
  // it, so a run cancelled mid-gate leaves the record behind. Reporting that as
  // something waiting on the human would be worse than useless: nothing is
  // listening for the answer any more, so acting on it can only fail.
  it('pending_approvals drops a run that was cancelled while parked on the gate', async () => {
    const h = makeHarness();
    const { runId } = await dispatchUntil(
      h,
      'Gated',
      'gated',
      'awaiting-approval'
    );
    await h.orchestrator.cancel(runId);

    expect(
      (h.registry.callStatusTool('pending_approvals') as { total: number })
        .total
    ).toBe(0);
  });

  it('open_questions lists unanswered questions and drops them once answered', () => {
    const h = makeHarness();
    const asked = h.questions.ask('r-abc123', 'Which database?', ['sqlite']);

    const before = h.registry.callStatusTool('open_questions') as {
      questions: Record<string, unknown>[];
      total: number;
    };
    expect(before.total).toBe(1);
    expect(before.questions[0]).toMatchObject({
      id: asked.id,
      runId: 'r-abc123',
      question: 'Which database?',
      options: ['sqlite'],
    });

    h.questions.answer(asked.id, 'sqlite');
    expect(
      (h.registry.callStatusTool('open_questions') as { total: number }).total
    ).toBe(0);
  });

  it('open_questions scopes to one run when given a runId', () => {
    const h = makeHarness();
    h.questions.ask('r-aaa111', 'First?');
    h.questions.ask('r-bbb222', 'Second?');

    const scoped = h.registry.callStatusTool('open_questions', {
      runId: 'r-bbb222',
    }) as { questions: { question: string }[]; total: number };
    expect(scoped.total).toBe(1);
    expect(scoped.questions[0].question).toBe('Second?');
  });

  it('ledger_entries returns project entries, and narrows to one epic on request', () => {
    const h = makeHarness();
    h.ledgerStore.add({
      kind: 'decision',
      title: 'Use bun',
      detail: 'faster',
      authoredBy: 'human:test',
      epicId: 'e-111111',
    });
    h.ledgerStore.add({
      kind: 'hazard',
      title: 'Flaky suite',
      detail: 'retries',
      authoredBy: 'human:test',
      epicId: 'e-222222',
    });

    const all = h.registry.callStatusTool('ledger_entries') as {
      total: number;
    };
    expect(all.total).toBe(2);

    const scoped = h.registry.callStatusTool('ledger_entries', {
      epicId: 'e-111111',
    }) as { entries: Record<string, unknown>[]; total: number };
    expect(scoped.total).toBe(1);
    expect(scoped.entries[0]).toMatchObject({
      kind: 'decision',
      title: 'Use bun',
      detail: 'faster',
    });
  });

  it('rejects arguments sent to a tool that takes none, rather than ignoring them', () => {
    const h = makeHarness();
    expect(() =>
      h.registry.callStatusTool('list_ready_tasks', { runId: 'r-abc123' })
    ).toThrow(WardenToolError);
  });
});

// ---------------------------------------------------------------------------
// Mutating tools — the pending-descriptor half
// ---------------------------------------------------------------------------

describe('warden mutating tools produce a pending action, never an effect', () => {
  it('dispatch_task describes the run without starting it', async () => {
    const h = makeHarness();
    const task = h.store.create({ title: 'Add feature' });
    h.cache.rebuild(h.store);

    const action = h.registry.callMutatingTool('dispatch_task', {
      taskId: task.meta.id,
    });
    expect(action.id).toMatch(/^wa-[0-9a-f]{6}$/);
    expect(action.tool).toBe('dispatch_task');
    expect(action.status).toBe('pending');
    expect(action.input).toEqual({ taskId: task.meta.id });
    expect(action.summary).toBe(
      `Dispatch ${task.meta.id} "Add feature" with the fake executor`
    );
    // The whole point: no run exists yet, and none appears afterwards either.
    await tick();
    expect(h.orchestrator.list()).toHaveLength(0);
  });

  it('approve_run describes the parked tool call without letting the run through', async () => {
    const h = makeHarness();
    const { runId } = await dispatchUntil(
      h,
      'Gated',
      'gated',
      'awaiting-approval'
    );

    const action = h.registry.callMutatingTool('approve_run', { runId });
    expect(action.summary).toBe(`Approve Bash on run ${runId} ("Gated")`);
    expect(h.orchestrator.getRun(runId)?.meta.state).toBe('awaiting-approval');
    expect(h.orchestrator.pendingApprovalFor(runId)).toBeDefined();
  });

  it('deny_run carries the reason into the summary without denying yet', async () => {
    const h = makeHarness();
    const { runId } = await dispatchUntil(
      h,
      'Gated',
      'gated',
      'awaiting-approval'
    );

    const action = h.registry.callMutatingTool('deny_run', {
      runId,
      reason: 'that would delete the repo',
    });
    expect(action.summary).toBe(
      `Deny Bash on run ${runId} ("Gated"): that would delete the repo`
    );
    expect(h.orchestrator.getRun(runId)?.meta.state).toBe('awaiting-approval');
  });

  it('cancel_run describes the cancel without stopping the run', async () => {
    const h = makeHarness();
    const { runId } = await dispatchUntil(h, 'Long one', 'slow', 'running');

    const action = h.registry.callMutatingTool('cancel_run', { runId });
    expect(action.summary).toBe(`Cancel run ${runId} ("Long one")`);
    await tick();
    expect(h.orchestrator.getRun(runId)?.meta.state).toBe('running');
  });

  it('dequeue_merge describes the removal without touching the queue', async () => {
    const h = makeHarness();
    const { runId } = await dispatchUntil(h, 'Held', 'fake', 'finished');
    // A stray untracked file makes the main checkout un-mergeable-into, which
    // parks the entry in 'blocked-environment' instead of racing it through —
    // the deterministic way to hold an entry in the queue mid-test.
    writeFileSync(join(repo, 'stray-download.zip'), 'nope\n');
    h.mergeQueue.enqueue(runId);
    await waitFor(
      () => h.mergeQueue.snapshot().entries[0]?.state === 'blocked-environment'
    );

    const action = h.registry.callMutatingTool('dequeue_merge', { runId });
    expect(action.summary).toBe(
      `Remove run ${runId} ("Held") from the merge queue`
    );
    expect(h.mergeQueue.snapshot().entries).toHaveLength(1);
  });

  it('message_run describes the message without delivering it', async () => {
    const h = makeHarness();
    const { runId } = await dispatchUntil(h, 'Long one', 'slow', 'running');

    const action = h.registry.callMutatingTool('message_run', {
      runId,
      text: 'check the tests',
    });
    expect(action.summary).toBe(
      `Message run ${runId} ("Long one"): check the tests`
    );
    const entries = h.orchestrator.getRun(runId)?.entries ?? [];
    expect(entries.some((e) => e.kind === 'message')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mutating tools — the applyAction half
// ---------------------------------------------------------------------------

describe('applyAction performs the real effect', () => {
  it('dispatch_task starts a run on the requested executor', async () => {
    const h = makeHarness();
    const task = h.store.create({ title: 'Add feature' });
    h.cache.rebuild(h.store);

    const action = h.registry.callMutatingTool('dispatch_task', {
      taskId: task.meta.id,
      executor: 'fake',
    });
    const applied = await h.registry.applyAction(action.id);

    expect(applied.status).toBe('applied');
    const runs = h.orchestrator.list();
    expect(runs).toHaveLength(1);
    expect(runs[0].taskId).toBe(task.meta.id);
    expect(runs[0].executor).toBe('fake');
  });

  it('approve_run lets the parked run continue to completion', async () => {
    const h = makeHarness();
    const { runId } = await dispatchUntil(
      h,
      'Gated',
      'gated',
      'awaiting-approval'
    );

    const action = h.registry.callMutatingTool('approve_run', { runId });
    await h.registry.applyAction(action.id);

    await waitFor(
      () => h.orchestrator.getRun(runId)?.meta.state === 'finished'
    );
    expect(h.orchestrator.pendingApprovalFor(runId)).toBeUndefined();
  });

  it('deny_run refuses the tool call and the reason reaches the run', async () => {
    const h = makeHarness();
    const { runId } = await dispatchUntil(
      h,
      'Gated',
      'gated',
      'awaiting-approval'
    );

    const action = h.registry.callMutatingTool('deny_run', {
      runId,
      reason: 'that would delete the repo',
    });
    await h.registry.applyAction(action.id);

    await waitFor(() => h.orchestrator.getRun(runId)?.meta.state === 'failed');
    expect(h.orchestrator.getRun(runId)?.meta.error).toContain(
      'that would delete the repo'
    );
  });

  it('cancel_run stops the run and records it on the task', async () => {
    const h = makeHarness();
    const { runId, taskId } = await dispatchUntil(
      h,
      'Long one',
      'slow',
      'running'
    );

    const action = h.registry.callMutatingTool('cancel_run', { runId });
    await h.registry.applyAction(action.id);

    expect(h.orchestrator.getRun(runId)?.meta.state).toBe('cancelled');
    expect(h.store.get(taskId)?.body).toContain(`[run ${runId}] cancelled`);
  });

  it('dequeue_merge takes the entry out of the queue', async () => {
    const h = makeHarness();
    const { runId } = await dispatchUntil(h, 'Held', 'fake', 'finished');
    writeFileSync(join(repo, 'stray-download.zip'), 'nope\n');
    h.mergeQueue.enqueue(runId);
    await waitFor(
      () => h.mergeQueue.snapshot().entries[0]?.state === 'blocked-environment'
    );

    const action = h.registry.callMutatingTool('dequeue_merge', { runId });
    await h.registry.applyAction(action.id);

    expect(h.mergeQueue.snapshot().entries).toHaveLength(0);
  });

  it('message_run delivers the message onto the run transcript', async () => {
    const h = makeHarness();
    const { runId } = await dispatchUntil(h, 'Long one', 'slow', 'running');

    const action = h.registry.callMutatingTool('message_run', {
      runId,
      text: 'check the tests',
    });
    await h.registry.applyAction(action.id);

    const entries = h.orchestrator.getRun(runId)?.entries ?? [];
    expect(
      entries.some(
        (e) =>
          e.kind === 'message' &&
          e.from === 'user' &&
          e.text === 'check the tests'
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid targets — one per mutating tool
// ---------------------------------------------------------------------------

describe('mutating tools refuse an invalid target at call time', () => {
  it('dispatch_task rejects a task id that does not exist', () => {
    const h = makeHarness();
    expect(() =>
      h.registry.callMutatingTool('dispatch_task', { taskId: 't-ghost0' })
    ).toThrow('task not found: t-ghost0');
  });

  it('approve_run rejects a run that is not awaiting approval', async () => {
    const h = makeHarness();
    const { runId } = await dispatchUntil(h, 'Done', 'fake', 'finished');
    expect(() => h.registry.callMutatingTool('approve_run', { runId })).toThrow(
      `run is not awaiting approval: ${runId}`
    );
    expect(() =>
      h.registry.callMutatingTool('approve_run', { runId: 'r-ghost0' })
    ).toThrow('run not found: r-ghost0');
  });

  it('deny_run rejects a run that is not awaiting approval', async () => {
    const h = makeHarness();
    const { runId } = await dispatchUntil(h, 'Done', 'fake', 'finished');
    expect(() => h.registry.callMutatingTool('deny_run', { runId })).toThrow(
      `run is not awaiting approval: ${runId}`
    );
  });

  // The same stale-record hazard pending_approvals has: the leftover approval
  // must not make a cancelled run look answerable, or the human confirms an
  // action that can only throw.
  it('approve_run and deny_run reject a run cancelled while parked on the gate', async () => {
    const h = makeHarness();
    const { runId } = await dispatchUntil(
      h,
      'Gated',
      'gated',
      'awaiting-approval'
    );
    await h.orchestrator.cancel(runId);

    expect(() => h.registry.callMutatingTool('approve_run', { runId })).toThrow(
      `run is not awaiting approval: ${runId}`
    );
    expect(() => h.registry.callMutatingTool('deny_run', { runId })).toThrow(
      `run is not awaiting approval: ${runId}`
    );
  });

  it('cancel_run rejects an unknown run and one that has already finished', async () => {
    const h = makeHarness();
    expect(() =>
      h.registry.callMutatingTool('cancel_run', { runId: 'r-ghost0' })
    ).toThrow('run not found: r-ghost0');

    const { runId } = await dispatchUntil(h, 'Done', 'fake', 'finished');
    expect(() => h.registry.callMutatingTool('cancel_run', { runId })).toThrow(
      `run already finished: ${runId}`
    );
  });

  it('dequeue_merge rejects a run that is not in the queue', async () => {
    const h = makeHarness();
    const { runId } = await dispatchUntil(h, 'Done', 'fake', 'finished');
    expect(() =>
      h.registry.callMutatingTool('dequeue_merge', { runId })
    ).toThrow(`run not found in merge queue: ${runId}`);
  });

  it('message_run rejects a run that is no longer live', async () => {
    const h = makeHarness();
    const { runId } = await dispatchUntil(h, 'Done', 'fake', 'finished');
    expect(() =>
      h.registry.callMutatingTool('message_run', { runId, text: 'hello' })
    ).toThrow(`run is not live: ${runId}`);
  });
});

// ---------------------------------------------------------------------------
// Action bookkeeping
// ---------------------------------------------------------------------------

describe('pending action bookkeeping', () => {
  it('lists pending actions and drops them once they are decided', async () => {
    const h = makeHarness();
    const a = h.store.create({ title: 'One' });
    const b = h.store.create({ title: 'Two' });
    h.cache.rebuild(h.store);

    const first = h.registry.callMutatingTool('dispatch_task', {
      taskId: a.meta.id,
    });
    const second = h.registry.callMutatingTool('dispatch_task', {
      taskId: b.meta.id,
    });
    expect(h.registry.listPending().map((x) => x.id)).toEqual([
      first.id,
      second.id,
    ]);

    await h.registry.applyAction(first.id);
    h.registry.denyAction(second.id);
    expect(h.registry.listPending()).toHaveLength(0);
    expect(h.registry.getAction(second.id)?.status).toBe('denied');
  });

  it('denying an action never performs it', () => {
    const h = makeHarness();
    const task = h.store.create({ title: 'Never dispatched' });
    h.cache.rebuild(h.store);

    const action = h.registry.callMutatingTool('dispatch_task', {
      taskId: task.meta.id,
    });
    h.registry.denyAction(action.id);

    expect(h.orchestrator.list()).toHaveLength(0);
  });

  it('refuses to apply the same action twice', async () => {
    const h = makeHarness();
    const task = h.store.create({ title: 'Add feature' });
    h.cache.rebuild(h.store);

    const action = h.registry.callMutatingTool('dispatch_task', {
      taskId: task.meta.id,
    });
    await h.registry.applyAction(action.id);

    // Without this, a double-confirm (two clicks, a retried request) would
    // dispatch the same task twice.
    expect(h.registry.applyAction(action.id)).rejects.toThrow(
      /already applied/
    );
    expect(h.orchestrator.list()).toHaveLength(1);
  });

  // The sequential test above passes even with the "claimed" flip AFTER the
  // await; only a race catches that. A chat UI double-click is exactly this
  // shape — two requests in flight before either has finished.
  it('refuses a second apply racing the first, not just one after it', async () => {
    const h = makeHarness();
    const task = h.store.create({ title: 'Add feature' });
    h.cache.rebuild(h.store);

    const action = h.registry.callMutatingTool('dispatch_task', {
      taskId: task.meta.id,
    });
    const results = await Promise.allSettled([
      h.registry.applyAction(action.id),
      h.registry.applyAction(action.id),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(h.orchestrator.list()).toHaveLength(1);
  });

  it('refuses to apply or deny an action it has never seen', () => {
    const h = makeHarness();
    expect(h.registry.applyAction('wa-ffffff')).rejects.toThrow(
      'unknown action: wa-ffffff'
    );
    expect(() => h.registry.denyAction('wa-ffffff')).toThrow(
      'unknown action: wa-ffffff'
    );
  });

  it('leaves an action pending when applying it fails, so it can be retried', async () => {
    const h = makeHarness();
    const task = h.store.create({ title: 'Add feature' });
    h.cache.rebuild(h.store);

    const action = h.registry.callMutatingTool('dispatch_task', {
      taskId: task.meta.id,
      executor: 'nonexistent-executor',
    });
    expect(h.registry.applyAction(action.id)).rejects.toThrow(
      /unknown executor/
    );
    await waitFor(() => h.registry.getAction(action.id)?.status === 'pending');
    expect(h.registry.listPending().map((x) => x.id)).toEqual([action.id]);
  });
});
