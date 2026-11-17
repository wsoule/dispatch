import {
  OVERSEER_GRANT_ANSWER,
  TaskStore,
  updateConfig,
} from '@dispatch-foo/core';
import type { JsonValue, Message, Sender } from '@dispatch-foo/protocol';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import type {
  BroadcastClient,
  ServerEvent,
  SocketAudience,
} from '../../src/events.js';
import { LedgerStore } from '../../src/ledger.js';
import { classifyLedgerEntry } from '../../src/memory/ledgerImport.js';
import { closeOrphanedGates } from '../../src/messaging/gates.js';
import {
  createOverseerBus,
  ensureOverseerActor,
  overseerToolMessaging,
} from '../../src/messaging/overseerBus.js';
import { openMessaging } from '../../src/messaging/service.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { MergeQueue } from '../../src/orchestrator/mergeQueue.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import {
  overseerActionRoute,
  overseerLiveAudience,
  OverseerManager,
  ROLLOVER_TOKENS,
} from '../../src/orchestrator/overseer.js';
import type { OverseerRecord } from '../../src/orchestrator/overseer.js';
import type {
  OverseerBackend,
  OverseerQuestion,
  OverseerQuestionAnswer,
  OverseerToolset,
  OverseerTurn,
  OverseerTurnOptions,
} from '../../src/orchestrator/overseerBackend.js';
import { FakeOverseer } from '../../src/orchestrator/overseers/fake.js';
import type {
  FakeOverseerScript,
  FakeOverseerTurn,
} from '../../src/orchestrator/overseers/fake.js';
import {
  fileOverseerStore,
  overseerDir,
} from '../../src/orchestrator/overseerStore.js';
import type { OverseerToolContext } from '../../src/orchestrator/overseerTools.js';
import { OverseerToolRegistry } from '../../src/orchestrator/overseerTools.js';
import type { CommandResult } from '../../src/orchestrator/pr.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from '../../src/orchestrator/types.js';
import type { ApprovalDecision } from '../../src/orchestrator/types.js';
import type { AuthTier } from '../../src/tiers.js';
import { initGitRepo, lateBoundOverseerMessaging } from './helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

// Same teardown contract as overseerTools.test.ts: a merge queue left running
// arms a retry timer, and a 'slow' run left live finishes during some LATER
// test against whatever DISPATCH_HOME is set then.
const liveQueues: MergeQueue[] = [];
const liveOrchestrators: Orchestrator[] = [];

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-overseer-mgr-');
});

afterEach(async () => {
  for (const queue of liveQueues) queue.stop();
  liveQueues.length = 0;
  for (const orchestrator of liveOrchestrators) {
    for (const meta of orchestrator.list()) {
      await orchestrator.cancel(meta.id).catch(() => {});
    }
  }
  liveOrchestrators.length = 0;
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

// Gives an effect that escaped confirmation a chance to land before a "nothing
// happened" assertion runs — without it those assertions read the world one
// microtask too early and would pass even if the effect were firing.
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

// Answers the git/gh invocations the merge queue makes, so no test here
// depends on a real rebase/push (copied in shape from overseerTools.test.ts).
function stubResult(cmd: string[]): CommandResult {
  const ok = { ok: true, stdout: '', stderr: '' };
  if (cmd[0] === 'git' && cmd[1] === 'fetch') return ok;
  if (cmd[0] === 'git' && cmd[1] === 'rebase') return ok;
  if (cmd[0] === 'bash' && cmd[1] === '-lc') return ok;
  if (cmd[0] === 'git' && cmd[1] === 'push') return ok;
  return { ok: false, stdout: '', stderr: 'unhandled stub command' };
}
const stubRunner = (_cwd: string, cmd: string[]): Promise<CommandResult> =>
  Promise.resolve(stubResult(cmd));

interface Harness extends OverseerToolContext {
  registry: OverseerToolRegistry;
  events: EventBus;
  seen: ServerEvent[];
  lateMessaging: ReturnType<typeof lateBoundOverseerMessaging>;
}

// A whole project's wiring over a throwaway git repo, assembled the way
// index.ts does it. Two executors: one that finishes immediately, one that
// stays live long enough to be cancelled.
function makeHarness(): Harness {
  const store = TaskStore.init(repo);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const seen: ServerEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const orchestrator = new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events,
  });
  liveOrchestrators.push(orchestrator);
  orchestrator.registerExecutor(
    'fake',
    new FakeExecutor({ finish: { state: 'finished', sessionId: 'sess-1' } })
  );
  orchestrator.registerExecutor(
    'slow',
    new FakeExecutor({
      steps: [{ delayMs: 60_000 }],
      finish: { state: 'finished', sessionId: 'sess-2' },
    })
  );
  const mergeQueue = new MergeQueue(
    { rootDir: repo, store, cache, events, orchestrator },
    stubRunner
  );
  liveQueues.push(mergeQueue);
  const lateMessaging = lateBoundOverseerMessaging();
  const ctx: OverseerToolContext = {
    store,
    cache,
    orchestrator,
    mergeQueue,
    openGates: () => [],
    ledgerStore: new LedgerStore(repo),
    defaultExecutor: 'fake',
    messaging: lateMessaging.port,
    ownerRef: 'human:test',
  };
  return {
    ...ctx,
    registry: new OverseerToolRegistry(ctx),
    events,
    seen,
    lateMessaging,
  };
}

interface ManagerHarness extends Harness {
  manager: OverseerManager;
  backend: FakeOverseer;
}

function makeManager(script: FakeOverseerScript): ManagerHarness {
  const h = makeHarness();
  const backend = new FakeOverseer(script);
  const manager = new OverseerManager({
    rootDir: repo,
    registry: h.registry,
    events: h.events,
  });
  manager.registerBackend('fake', backend);
  return { ...h, manager, backend };
}

// Starts a conversation and returns its record once the turn has settled.
async function startAndSettle(
  h: ManagerHarness,
  prompt = 'what is going on?'
): Promise<OverseerRecord> {
  const started = h.manager.start(prompt, 'fake');
  await waitFor(() => h.manager.get(started.id).state !== 'running');
  return h.manager.get(started.id);
}

function makeTask(h: Harness, title: string): string {
  const doc = h.store.create({ title });
  h.cache.rebuild(h.store);
  return doc.meta.id;
}

// ---------------------------------------------------------------------------
// Turn bookkeeping
// ---------------------------------------------------------------------------

describe('OverseerManager turns', () => {
  it('opens at running with the prompt recorded, then lands the reply at ready', async () => {
    const h = makeManager({ ok: true, reply: 'nothing is on fire' });

    const started = h.manager.start('what is going on?', 'fake');
    expect(started.state).toBe('running');
    expect(started.messages).toEqual([
      { role: 'user', text: 'what is going on?', at: expect.any(String) },
    ]);
    expect(started.prompt).toBe('what is going on?');
    expect(started.pendingActions).toEqual([]);

    await waitFor(() => h.manager.get(started.id).state !== 'running');
    const settled = h.manager.get(started.id);
    expect(settled.state).toBe('ready');
    expect(settled.error).toBeUndefined();
    expect(settled.messages.at(-1)).toMatchObject({
      role: 'assistant',
      text: 'nothing is on fire',
    });
    // The backend's resume handle is kept for the next turn.
    expect(settled.sessionId).toBe('1');
    expect(h.seen.some((e) => e.type === 'overseer.changed')).toBe(true);
  });

  it('runs a status tool during the turn and records what it returned', async () => {
    const h = makeManager({
      ok: true,
      turns: [
        {
          calls: [{ tool: 'list_ready_tasks' }],
          reply: (results) =>
            `ready: ${(results[0].content as { total: number }).total}`,
        },
      ],
    });
    makeTask(h, 'Ship the thing');

    const record = await startAndSettle(h, 'what can I dispatch?');

    expect(record.messages.at(-1)?.text).toBe('ready: 1');
    const toolEntry = record.messages.find((m) => m.role === 'tool');
    expect(toolEntry?.tool).toBe('list_ready_tasks');
    expect(toolEntry?.text).toContain('Ship the thing');
    // It ran before the row landed, so the row says how it went.
    expect(toolEntry?.status).toBe('done');
    // The model saw the real payload, not a summary of it.
    expect(h.backend.observations[0].result.isError).toBe(false);
  });

  it('derives a later call input from an earlier result in the same turn', async () => {
    // The shape bin.ts's default fake overseer script relies on: read the ready
    // list, then queue a dispatch of whatever task that read returned — no
    // hard-coded id anywhere in the script.
    const h = makeManager({
      ok: true,
      turns: [
        {
          calls: [
            { tool: 'list_ready_tasks' },
            {
              tool: 'dispatch_task',
              input: (prior) => {
                const listed = prior[0].content as {
                  tasks: { id: string }[];
                };
                return { taskId: listed.tasks[0].id, executor: 'fake' };
              },
            },
          ],
          reply: 'queued it',
        },
      ],
    });
    const taskId = makeTask(h, 'Ship the thing');

    const record = await startAndSettle(h, 'dispatch the next ready task');

    expect(record.pendingActions).toHaveLength(1);
    expect(record.pendingActions[0].tool).toBe('dispatch_task');
    expect(record.pendingActions[0].input).toEqual({
      taskId,
      executor: 'fake',
    });
    // The observation records the resolved input, not the function.
    expect(h.backend.observations[1].input).toEqual({
      taskId,
      executor: 'fake',
    });
    // Queued only — deriving the input dynamically must not change the "a
    // mutating call never executes" contract.
    expect(h.orchestrator.list()).toEqual([]);
  });

  it('hands a bad tool call back to the model as an error and still settles ready', async () => {
    const h = makeManager({
      ok: true,
      turns: [
        {
          calls: [
            { tool: 'cancel_run', input: {} },
            { tool: 'summon_the_moon' },
          ],
          reply: 'sorry, let me try that again',
        },
      ],
    });

    const record = await startAndSettle(h);

    expect(record.state).toBe('ready');
    expect(h.backend.observations.map((o) => o.result.isError)).toEqual([
      true,
      true,
    ]);
    expect(JSON.stringify(h.backend.observations[0].result.content)).toContain(
      'invalid input for cancel_run'
    );
    expect(JSON.stringify(h.backend.observations[1].result.content)).toContain(
      'unknown overseer tool: summon_the_moon'
    );
    // A call that failed its schema is not a queued action.
    expect(record.pendingActions).toEqual([]);
    expect(
      record.messages.filter((m) => m.role === 'tool').map((m) => m.status)
    ).toEqual(['error', 'error']);
  });

  it('lands at failed with the backend error when a turn throws', async () => {
    const h = makeManager({ ok: false, error: 'model unreachable' });

    const record = await startAndSettle(h);

    expect(record.state).toBe('failed');
    expect(record.error).toBe('model unreachable');
  });

  it('resumes the prior session on a follow-up and keeps the whole transcript', async () => {
    const h = makeManager({
      ok: true,
      turns: [{ reply: 'first' }, { reply: 'second' }],
    });

    const record = await startAndSettle(h, 'one');
    h.manager.sendMessage(record.id, 'two');
    await waitFor(() => h.manager.get(record.id).state === 'ready');

    const settled = h.manager.get(record.id);
    expect(settled.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:one',
      'assistant:first',
      'user:two',
      'assistant:second',
    ]);
    expect(settled.sessionId).toBe('2');
  });

  it('advertises every registry tool, flagging which ones mutate', async () => {
    const h = makeManager({ ok: true, reply: 'ok' });
    let offered: OverseerToolset | undefined;
    h.manager.registerBackend('spy', {
      start: (_prompt, toolset) => {
        offered = toolset;
        return Promise.resolve({ reply: 'ok' });
      },
      sendMessage: () => Promise.resolve({ reply: 'ok' }),
    });

    const started = h.manager.start('hi', 'spy');
    await waitFor(() => h.manager.get(started.id).state === 'ready');

    const names = offered?.tools.map((t) => t.name) ?? [];
    expect(names).toContain('list_runs');
    expect(names).toContain('dispatch_task');
    expect(names).toHaveLength(
      h.registry.statusTools().length + h.registry.mutatingTools().length
    );
    const mutating = (offered?.tools ?? [])
      .filter((t) => t.mutating)
      .map((t) => t.name)
      .sort();
    expect(mutating).toEqual([
      'approve_run',
      'cancel_run',
      'create_plan',
      'create_task',
      'deny_run',
      'dequeue_merge',
      'discard_run',
      'dispatch_task',
      'message_run',
      'queue_merge',
      'send_as_you',
      'update_task',
    ]);
  });

  it('rejects an unknown backend name and an unknown conversation id', () => {
    const h = makeManager({ ok: true, reply: 'ok' });
    expect(() => h.manager.start('hi', 'nope')).toThrow(
      OrchestratorClientError
    );
    expect(() => h.manager.get('wc-nope')).toThrow(OrchestratorNotFoundError);
    expect(h.manager.registeredBackendNames()).toEqual(['fake']);
  });
});

// ---------------------------------------------------------------------------
// Queued actions
// ---------------------------------------------------------------------------

/**
 * Runs one conversation whose only tool call is `dispatch_task` on a fresh
 * task, and returns it with that action queued. Nothing has been dispatched at
 * this point — that is the invariant most of these tests build on. The task has
 * to exist before the script is written, which is why this assembles the
 * harness itself rather than taking one.
 */
async function queueDispatch(title = 'Ship the thing'): Promise<{
  h: ManagerHarness;
  record: OverseerRecord;
  taskId: string;
  actionId: string;
}> {
  const base = makeHarness();
  const taskId = makeTask(base, title);
  const backend = new FakeOverseer({
    ok: true,
    turns: [
      {
        calls: [{ tool: 'dispatch_task', input: { taskId } }],
        reply: 'queued it for you',
      },
      { reply: 'anything else?' },
    ],
  });
  const manager = new OverseerManager({
    rootDir: repo,
    registry: base.registry,
    events: base.events,
  });
  manager.registerBackend('fake', backend);
  const h: ManagerHarness = { ...base, manager, backend };
  const record = await startAndSettle(h, 'dispatch it');
  return { h, record, taskId, actionId: record.pendingActions[0].id };
}

describe('OverseerManager queued actions', () => {
  it('queues a mutating call with its summary and dispatches nothing', async () => {
    const { h, record, taskId } = await queueDispatch();

    expect(record.state).toBe('ready');
    expect(record.pendingActions).toHaveLength(1);
    const action = record.pendingActions[0];
    expect(action.tool).toBe('dispatch_task');
    expect(action.status).toBe('pending');
    expect(action.summary).toContain(taskId);
    expect(action.summary).toContain('Ship the thing');
    expect(record.messages.at(-2)).toMatchObject({
      role: 'action',
      tool: 'dispatch_task',
      actionId: action.id,
      outcome: 'pending',
      // Kept on the queued row so a decided action's card can still show it.
      input: { taskId },
    });
    // The model is told, in as many words, that nothing happened.
    const told = JSON.stringify(h.backend.observations[0].result.content);
    expect(told).toContain('"queued":true');
    expect(told).toContain('NOTHING has happened yet');
    // And nothing did.
    await tick();
    expect(h.orchestrator.list()).toEqual([]);
  });

  it('applies for real on approval and folds the outcome into the transcript', async () => {
    const { h, record: opened, taskId, actionId } = await queueDispatch();

    const record = await h.manager.confirmAction(opened.id, actionId, true);

    expect(h.orchestrator.list()).toHaveLength(1);
    expect(h.orchestrator.list()[0].taskId).toBe(taskId);
    expect(record.pendingActions).toEqual([]);
    expect(record.messages.at(-1)).toMatchObject({
      role: 'action',
      actionId,
      outcome: 'applied',
      // The task it sent out, so the chat can list it and open it.
      taskIds: [taskId],
      // The result card's link to what the action touched.
      entities: [taskId],
    });
    expect(record.messages.at(-1)?.text).toStartWith('Applied: Dispatch');
    expect(h.registry.getAction(actionId)?.status).toBe('applied');
  });

  it('never applies on denial and records the refusal', async () => {
    const { h, record: opened, actionId } = await queueDispatch();

    const record = await h.manager.confirmAction(opened.id, actionId, false);

    await tick();
    expect(h.orchestrator.list()).toEqual([]);
    expect(h.registry.getAction(actionId)?.status).toBe('denied');
    expect(record.pendingActions).toEqual([]);
    expect(record.messages.at(-1)).toMatchObject({
      role: 'action',
      actionId,
      outcome: 'denied',
    });
    expect(record.messages.at(-1)?.text).toStartWith('Denied: Dispatch');
  });

  it('refuses to confirm an action queued by a different conversation', async () => {
    // One registry is shared by every conversation, so this is the guard that
    // stops conversation A from confirming what conversation B queued.
    const { h, record: first } = await queueDispatch();
    const second = await startAndSettle(h, 'dispatch it too');
    const otherActionId = second.pendingActions[0].id;
    expect(otherActionId).not.toBe(first.pendingActions[0].id);

    await expect(
      h.manager.confirmAction(first.id, otherActionId, true)
    ).rejects.toThrow(OrchestratorNotFoundError);

    await tick();
    expect(h.orchestrator.list()).toEqual([]);
    // Still confirmable where it actually belongs.
    expect(h.manager.get(second.id).pendingActions).toHaveLength(1);
    expect(h.registry.getAction(otherActionId)?.status).toBe('pending');
  });

  it('applies a confirmed action exactly once', async () => {
    const { h, record: opened, actionId } = await queueDispatch();

    const [first, second] = await Promise.allSettled([
      h.manager.confirmAction(opened.id, actionId, true),
      h.manager.confirmAction(opened.id, actionId, true),
    ]);

    // The loser is refused cleanly rather than reported as a failed action:
    // the confirmation is claimed before the effect is awaited, so the second
    // click never reaches applyAction at all.
    const record = h.manager.get(opened.id);
    expect(record.pendingActions).toEqual([]);
    expect(record.messages.filter((m) => m.outcome === 'failed')).toEqual([]);
    expect(record.messages.filter((m) => m.outcome === 'applied')).toHaveLength(
      1
    );
    expect([first.status, second.status].sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(h.orchestrator.list()).toHaveLength(1);
  });

  it('rejects confirming an unknown action id', async () => {
    const h = makeManager({ ok: true, reply: 'ok' });
    const record = await startAndSettle(h);
    await expect(
      h.manager.confirmAction(record.id, 'wa-nope', true)
    ).rejects.toThrow(OrchestratorNotFoundError);
  });

  it('settles an action as failed and records the failure when applying throws', async () => {
    const h = makeManager({ ok: true, reply: 'placeholder' });
    // A run that stays live long enough to queue a cancel against it...
    const taskId = makeTask(h, 'Long one');
    const meta = await h.orchestrator.dispatch(taskId, 'slow');
    const backend = new FakeOverseer({
      ok: true,
      turns: [
        {
          calls: [{ tool: 'cancel_run', input: { runId: meta.id } }],
          reply: 'queued a cancel',
        },
        { reply: 'that did not work' },
      ],
    });
    h.manager.registerBackend('fake', backend);
    const opened = await startAndSettle(h, 'cancel it');
    const actionId = opened.pendingActions[0].id;
    // ...and is then cancelled out from under the queued action, so applying
    // it hits the orchestrator's own "already finished" conflict.
    await h.orchestrator.cancel(meta.id);

    await expect(
      h.manager.confirmAction(opened.id, actionId, true)
    ).rejects.toThrow();

    // The model is told it failed, at once.
    await waitFor(() => h.manager.get(opened.id).state === 'ready');
    expect(backend.prompts[1]).toContain('but it failed');
    const record = h.manager.get(opened.id);
    expect(record.pendingActions).toEqual([]);
    expect(record.messages.at(-2)).toMatchObject({
      role: 'action',
      actionId,
      outcome: 'failed',
    });
    expect(record.messages.at(-1)?.text).toBe('that did not work');
    expect(h.registry.getAction(actionId)?.status).toBe('failed');
  });

  it('tells the model what the human decided as soon as they decide', async () => {
    const { h, record: opened, actionId } = await queueDispatch();
    const rows = opened.messages.length;

    const record = await h.manager.confirmAction(opened.id, actionId, false);

    // The turn starts before the confirm returns, with no line from the human.
    expect(record.state).toBe('running');
    await waitFor(() => h.manager.get(opened.id).state === 'ready');
    // The model's own tool result only ever said "queued", so this turn is
    // the only way it learns the human refused.
    const told = h.backend.prompts[1];
    expect(told).toContain('REFUSED');
    expect(told).toContain('Dispatch');
    // Delivered once, not on every later turn.
    const settled = h.manager.get(opened.id);
    expect(settled.undeliveredDecisions).toEqual([]);
    // The transcript gains the decision and the reply, never a made-up human line.
    expect(settled.messages.slice(rows).map((m) => m.role)).toEqual([
      'action',
      'assistant',
    ]);
    expect(settled.messages.at(-1)?.text).toBe('anything else?');
  });

  it('tells the model right after the turn it was decided during', async () => {
    const base = makeHarness();
    const taskId = makeTask(base, 'Ship the thing');
    const backend = new HeldFakeOverseer({
      ok: true,
      turns: [
        {
          calls: [{ tool: 'dispatch_task', input: { taskId } }],
          reply: 'queued it for you',
        },
        { reply: 'still thinking' },
        { reply: 'noted' },
      ],
    });
    const manager = new OverseerManager({
      rootDir: repo,
      registry: base.registry,
      events: base.events,
    });
    manager.registerBackend('fake', backend);
    const h: ManagerHarness = { ...base, manager, backend };
    const opened = await startAndSettle(h, 'dispatch it');
    const actionId = opened.pendingActions[0].id;

    let release = (): void => {};
    backend.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.manager.sendMessage(opened.id, 'what else is there?');
    await h.manager.confirmAction(opened.id, actionId, true);
    // The running turn was asked before the decision, so it cannot carry it.
    expect(h.manager.get(opened.id).undeliveredDecisions).toHaveLength(1);

    release();
    await waitFor(() => backend.prompts.length === 3);
    await waitFor(() => h.manager.get(opened.id).state === 'ready');
    expect(backend.prompts[1]).toEndWith('what else is there?');
    expect(backend.prompts[2]).toContain('approved this');
    expect(h.manager.get(opened.id).undeliveredDecisions).toEqual([]);
    expect(h.manager.get(opened.id).messages.at(-1)?.text).toBe('noted');
  });

  it('keeps the decision for the next attempt when the turn carrying it fails', async () => {
    const { h, record: opened, actionId } = await queueDispatch();

    // The turn that would have delivered the news dies before reaching a model.
    h.manager.registerBackend(
      'fake',
      new FakeOverseer({ ok: false, error: 'model unreachable' })
    );
    await h.manager.confirmAction(opened.id, actionId, true);
    await waitFor(() => h.manager.get(opened.id).state === 'failed');
    expect(h.manager.get(opened.id).undeliveredDecisions).toHaveLength(1);
    // A failed delivery is not retried on its own, which would loop.
    await tick();
    expect(h.manager.get(opened.id).state).toBe('failed');

    // So the human's next line still carries it.
    const retry = new FakeOverseer({ ok: true, reply: 'yes, it is running' });
    h.manager.registerBackend('fake', retry);
    h.manager.sendMessage(opened.id, 'did it go?');
    await waitFor(() => h.manager.get(opened.id).state === 'ready');
    expect(retry.prompts[0]).toContain('approved');
    expect(retry.prompts[0]).toEndWith('did it go?');
    expect(h.manager.get(opened.id).undeliveredDecisions).toEqual([]);
  });
});

// A FakeOverseer whose next follow-up waits on `hold`, so a test can decide
// an action while that turn is still running.
class HeldFakeOverseer extends FakeOverseer {
  hold: Promise<void> | null = null;

  override async sendMessage(
    ...args: Parameters<FakeOverseer['sendMessage']>
  ): Promise<OverseerTurn> {
    const hold = this.hold;
    this.hold = null;
    if (hold !== null) await hold;
    return super.sendMessage(...args);
  }
}

// ---------------------------------------------------------------------------
// Built-in tool gate
// ---------------------------------------------------------------------------

// A backend standing in for a full Claude Code session: each turn asks the
// manager about the built-in calls it is scripted to make, in order, and
// replies with what it was told. `decisions` is what a real session would act
// on — a call is "run" only if the answer was allow.
class GatedBackend implements OverseerBackend {
  readonly decisions: ({ toolName: string } & ApprovalDecision)[] = [];
  options: OverseerTurnOptions | undefined;

  constructor(
    private readonly calls: {
      toolName: string;
      input: unknown;
      check?: string;
    }[],
    private readonly reply = 'done'
  ) {}

  start(
    _prompt: string,
    _toolset: OverseerToolset,
    options?: OverseerTurnOptions
  ): Promise<OverseerTurn> {
    return this.turn(options);
  }

  sendMessage(
    _sessionId: string | undefined,
    _message: string,
    _toolset: OverseerToolset,
    options?: OverseerTurnOptions
  ): Promise<OverseerTurn> {
    return this.turn(options);
  }

  private async turn(options?: OverseerTurnOptions): Promise<OverseerTurn> {
    this.options = options;
    let n = 0;
    for (const call of this.calls) {
      n += 1;
      options?.onToolUse?.(call.toolName, call.input);
      const decision = (await options?.authorizeTool?.({
        requestId: `req-${n}`,
        toolName: call.toolName,
        input: call.input,
        ...(call.check === undefined ? {} : { check: call.check }),
      })) ?? { allow: false };
      this.decisions.push({ toolName: call.toolName, ...decision });
    }
    return { reply: this.reply, sessionId: 'sess' };
  }
}

function makeGated(
  calls: { toolName: string; input: unknown; check?: string }[]
): ManagerHarness & { gated: GatedBackend } {
  const h = makeManager({ ok: true, reply: 'unused' });
  const gated = new GatedBackend(calls);
  h.manager.registerBackend('gated', gated);
  return { ...h, gated };
}

describe('OverseerManager built-in tool gate', () => {
  it('parks a built-in call on the record and runs it once the human allows', async () => {
    const h = makeGated([
      { toolName: 'Bash', input: { command: 'git status' } },
    ]);

    const started = h.manager.start('what changed?', 'gated');
    await waitFor(() => h.manager.get(started.id).pendingApprovals.length > 0);

    const parked = h.manager.get(started.id);
    expect(parked.state).toBe('running');
    expect(parked.pendingApprovals).toEqual([
      {
        requestId: 'req-1',
        toolName: 'Bash',
        input: { command: 'git status' },
        summary: 'Bash: git status',
        requestedAt: expect.any(String),
      },
    ]);
    // The transcript shows the call (from onToolUse) and the parked request.
    expect(parked.messages.map((m) => `${m.role}:${m.outcome ?? ''}`)).toEqual([
      'user:',
      'tool:',
      'approval:pending',
    ]);
    // Nothing ran while the human was deciding.
    expect(h.gated.decisions).toEqual([]);

    const decided = h.manager.decideApproval(started.id, 'req-1', {
      allow: true,
    });
    expect(decided.pendingApprovals).toEqual([]);
    expect(decided.messages.at(-1)).toMatchObject({
      role: 'approval',
      tool: 'Bash',
      requestId: 'req-1',
      outcome: 'allowed',
      text: 'Allowed: Bash: git status',
    });

    await waitFor(() => h.manager.get(started.id).state === 'ready');
    expect(h.gated.decisions).toEqual([{ toolName: 'Bash', allow: true }]);
  });

  it('hands a denial and its reason to the session', async () => {
    const h = makeGated([{ toolName: 'Edit', input: { file_path: 'a.ts' } }]);
    const started = h.manager.start('fix it', 'gated');
    await waitFor(() => h.manager.get(started.id).pendingApprovals.length > 0);

    const decided = h.manager.decideApproval(started.id, 'req-1', {
      allow: false,
      reason: 'not that file',
    });
    expect(decided.messages.at(-1)).toMatchObject({
      role: 'approval',
      outcome: 'denied',
      text: 'Denied: Edit: a.ts — not that file',
    });

    await waitFor(() => h.manager.get(started.id).state === 'ready');
    expect(h.gated.decisions).toEqual([
      { toolName: 'Edit', allow: false, reason: 'not that file' },
    ]);
  });

  it('allowing for the conversation skips the human for that tool afterwards', async () => {
    const h = makeGated([
      { toolName: 'Bash', input: { command: 'ls' } },
      { toolName: 'Bash', input: { command: 'ls src' } },
      { toolName: 'Read', input: { file_path: 'README.md' } },
    ]);
    const started = h.manager.start('look around', 'gated');
    await waitFor(() => h.manager.get(started.id).pendingApprovals.length > 0);

    h.manager.decideApproval(started.id, 'req-1', {
      allow: true,
      scope: 'session',
    });
    // The second Bash call never parks; the Read still does.
    await waitFor(
      () => h.manager.get(started.id).pendingApprovals[0]?.toolName === 'Read'
    );
    expect(h.gated.decisions).toEqual([
      { toolName: 'Bash', allow: true, scope: 'session' },
      { toolName: 'Bash', allow: true },
    ]);
    expect(
      h.manager
        .get(started.id)
        .messages.find((m) => m.role === 'approval' && m.outcome === 'allowed')
    ).toMatchObject({
      text: 'Allowed Bash program "ls" for this conversation (up to 4 hours): Bash: ls',
    });
    h.manager.decideApproval(started.id, 'req-3', { allow: false });
    await waitFor(() => h.manager.get(started.id).state === 'ready');
  });

  it('a Bash grant covers its own program, not another', async () => {
    const h = makeGated([
      { toolName: 'Bash', input: { command: 'moonx desktop:test' } },
      { toolName: 'Bash', input: { command: 'rm -rf build' } },
    ]);
    const started = h.manager.start('test it', 'gated');
    await waitFor(() => h.manager.get(started.id).pendingApprovals.length > 0);
    h.manager.decideApproval(started.id, 'req-1', {
      allow: true,
      scope: 'session',
    });
    // `rm` is another program, so it parks for a human.
    await waitFor(
      () => h.manager.get(started.id).pendingApprovals[0]?.requestId === 'req-2'
    );
    expect(h.manager.listGrants(started.id).map((g) => g.key)).toEqual([
      'Bash program "moonx"',
    ]);
    h.manager.decideApproval(started.id, 'req-2', { allow: false });
    await waitFor(() => h.manager.get(started.id).state === 'ready');
  });

  it('a held call always asks, and a session answer to it grants nothing', async () => {
    const h = makeGated([
      {
        toolName: 'Bash',
        input: { command: 'dispatch task list' },
        check: 'dispatch-cli',
      },
      {
        toolName: 'Bash',
        input: { command: 'dispatch task list' },
        check: 'dispatch-cli',
      },
    ]);
    const started = h.manager.start('list tasks', 'gated');
    await waitFor(() => h.manager.get(started.id).pendingApprovals.length > 0);
    expect(h.manager.get(started.id).pendingApprovals[0]?.held).toBe(true);
    h.manager.decideApproval(started.id, 'req-1', {
      allow: true,
      scope: 'session',
    });
    await waitFor(
      () => h.manager.get(started.id).pendingApprovals[0]?.requestId === 'req-2'
    );
    expect(h.manager.listGrants(started.id)).toEqual([]);
    h.manager.decideApproval(started.id, 'req-2', { allow: false });
    await waitFor(() => h.manager.get(started.id).state === 'ready');
  });

  it('a revoked grant asks again', async () => {
    const h = makeGated([{ toolName: 'Edit', input: { file_path: 'a.ts' } }]);
    const started = h.manager.start('edit', 'gated');
    await waitFor(() => h.manager.get(started.id).pendingApprovals.length > 0);
    h.manager.decideApproval(started.id, 'req-1', {
      allow: true,
      scope: 'session',
    });
    await waitFor(() => h.manager.get(started.id).state === 'ready');
    expect(h.manager.revokeGrant(started.id, 'Edit')).toBe(true);
    expect(h.manager.listGrants(started.id)).toEqual([]);
  });

  it('never lets a session grant or acceptEdits wave an irreversible command through', async () => {
    const h = makeGated([
      { toolName: 'Bash', input: { command: 'git status' } },
      { toolName: 'Bash', input: { command: 'git push --force origin main' } },
    ]);
    const started = h.manager.start('ship it', 'gated');
    await waitFor(() => h.manager.get(started.id).pendingApprovals.length > 0);
    h.manager.decideApproval(started.id, 'req-1', {
      allow: true,
      scope: 'session',
    });
    // The force-push parks despite the grant.
    await waitFor(
      () => h.manager.get(started.id).pendingApprovals[0]?.requestId === 'req-2'
    );
    h.manager.decideApproval(started.id, 'req-2', { allow: false });
    await waitFor(() => h.manager.get(started.id).state === 'ready');
    expect(h.gated.decisions.map((d) => d.allow)).toEqual([true, false]);
  });

  it('under acceptEdits the edit tools run without asking and the rest still park', async () => {
    updateConfig(repo, { permissionMode: 'acceptEdits' });
    const h = makeGated([
      { toolName: 'Edit', input: { file_path: 'a.ts' } },
      { toolName: 'Bash', input: { command: 'bun test' } },
    ]);
    const started = h.manager.start('fix it', 'gated');
    await waitFor(() => h.manager.get(started.id).pendingApprovals.length > 0);
    expect(h.gated.decisions).toEqual([{ toolName: 'Edit', allow: true }]);
    expect(h.manager.get(started.id).pendingApprovals[0]?.toolName).toBe(
      'Bash'
    );
    expect(h.gated.options?.permissionMode).toBe('acceptEdits');
    h.manager.decideApproval(started.id, 'req-2', { allow: true });
    await waitFor(() => h.manager.get(started.id).state === 'ready');
  });

  it('refuses a decision for a request that is not parked on that conversation', async () => {
    const h = makeGated([{ toolName: 'Bash', input: { command: 'ls' } }]);
    const a = h.manager.start('a', 'gated');
    await waitFor(() => h.manager.get(a.id).pendingApprovals.length > 0);
    const b = h.manager.start('b', 'fake');
    await waitFor(() => h.manager.get(b.id).state === 'ready');

    expect(() =>
      h.manager.decideApproval(b.id, 'req-1', { allow: true })
    ).toThrow(OrchestratorNotFoundError);
    expect(() =>
      h.manager.decideApproval(a.id, 'req-9', { allow: true })
    ).toThrow(OrchestratorNotFoundError);
    // Still parked, still decidable on the right conversation.
    expect(h.manager.get(a.id).pendingApprovals).toHaveLength(1);
    h.manager.decideApproval(a.id, 'req-1', { allow: true });
    // A second decision on the same request finds nothing.
    expect(() =>
      h.manager.decideApproval(a.id, 'req-1', { allow: true })
    ).toThrow(OrchestratorNotFoundError);
  });

  it('denies whatever is still parked when the turn dies underneath it', async () => {
    // A backend that parks a call and then throws before it is decided.
    const dying: OverseerBackend = {
      start: async (_prompt, _toolset, options) => {
        void options?.authorizeTool?.({
          requestId: 'req-x',
          toolName: 'Bash',
          input: { command: 'ls' },
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('session crashed');
      },
      sendMessage: () => Promise.reject(new Error('unused')),
    };
    const h = makeManager({ ok: true, reply: 'unused' });
    h.manager.registerBackend('dying', dying);
    const started = h.manager.start('hi', 'dying');
    await waitFor(() => h.manager.get(started.id).state === 'failed');

    const failed = h.manager.get(started.id);
    expect(failed.pendingApprovals).toEqual([]);
    expect(failed.messages.at(-1)).toMatchObject({
      role: 'approval',
      requestId: 'req-x',
      outcome: 'denied',
    });
    expect(() =>
      h.manager.decideApproval(started.id, 'req-x', { allow: true })
    ).toThrow(OrchestratorNotFoundError);
  });
});

describe('OverseerManager turn options', () => {
  it("runs on the overseer role's configured model and the run policy by default", async () => {
    updateConfig(repo, {
      models: { overseer: 'claude-fable-5-1' },
      maxTurns: 12,
      maxBudgetUsd: 3,
    });
    const h = makeGated([]);
    const started = h.manager.start('hi', 'gated');
    await waitFor(() => h.manager.get(started.id).state === 'ready');
    expect(started.model).toBeUndefined();
    expect(h.gated.options).toMatchObject({
      model: 'claude-fable-5-1',
      permissionMode: 'auto',
      maxTurns: 12,
      maxBudgetUsd: 3,
    });
  });

  it('keeps a chosen model on the record and reuses it for every follow-up', async () => {
    const h = makeGated([]);
    const started = h.manager.start('hi', 'gated', 'claude-fable-5-1');
    expect(started.model).toBe('claude-fable-5-1');
    await waitFor(() => h.manager.get(started.id).state === 'ready');
    expect(h.gated.options?.model).toBe('claude-fable-5-1');

    // A settings change in between does not move an open conversation.
    updateConfig(repo, { models: { overseer: 'claude-haiku-5-5' } });
    h.manager.sendMessage(started.id, 'and?');
    await waitFor(() => h.manager.get(started.id).state === 'ready');
    expect(h.gated.options?.model).toBe('claude-fable-5-1');
  });

  it('changes model and effort for the next turns, and null restores the default', async () => {
    updateConfig(repo, { models: { overseer: 'claude-haiku-5-5' } });
    const h = makeGated([]);
    const started = h.manager.start('hi', 'gated', 'claude-fable-5-1');
    await waitFor(() => h.manager.get(started.id).state === 'ready');

    const changed = h.manager.setOptions(started.id, {
      model: 'claude-sonnet-5',
      effort: 'high',
    });
    expect(changed).toMatchObject({ model: 'claude-sonnet-5', effort: 'high' });
    h.manager.sendMessage(started.id, 'next');
    await waitFor(() => h.manager.get(started.id).state === 'ready');
    expect(h.gated.options).toMatchObject({
      model: 'claude-sonnet-5',
      effort: 'high',
    });

    h.manager.setOptions(started.id, { model: null, effort: null });
    h.manager.sendMessage(started.id, 'again');
    await waitFor(() => h.manager.get(started.id).state === 'ready');
    expect(h.gated.options?.model).toBe('claude-haiku-5-5');
    expect(h.gated.options?.effort).toBeUndefined();
  });

  it('sends no effort by default, then config effort.overseer, and a chosen effort wins', async () => {
    const h = makeGated([]);
    const plain = h.manager.start('hi', 'gated');
    await waitFor(() => h.manager.get(plain.id).state === 'ready');
    expect(h.gated.options?.effort).toBeUndefined();

    appendFileSync(
      join(repo, '.dispatch', 'config.yml'),
      'effort:\n  overseer: high\n'
    );
    h.manager.sendMessage(plain.id, 'and?');
    await waitFor(() => h.manager.get(plain.id).state === 'ready');
    expect(h.gated.options?.effort).toBe('high');

    const chosen = h.manager.start('hi', 'gated', undefined, 'max');
    expect(chosen.effort).toBe('max');
    await waitFor(() => h.manager.get(chosen.id).state === 'ready');
    expect(h.gated.options?.effort).toBe('max');
  });
});

describe('OverseerManager backend choice', () => {
  it('opens a conversation with no backend named on the default agent', async () => {
    const h = makeManager({ ok: true, reply: 'unused' });
    h.manager.registerBackend('claude', new GatedBackend([]));
    h.manager.registerBackend('codex', new GatedBackend([]));

    const onClaude = h.manager.start('hi');
    expect(onClaude.backendName).toBe('claude');
    await waitFor(() => h.manager.get(onClaude.id).state === 'ready');

    updateConfig(repo, { executor: 'codex' });
    const onCodex = h.manager.start('hi');
    expect(onCodex.backendName).toBe('codex');
    await waitFor(() => h.manager.get(onCodex.id).state === 'ready');
  });

  it('a Codex conversation never runs on a Claude model', async () => {
    updateConfig(repo, {
      models: { overseer: 'claude-fable-5-1' },
      executors: { codex: { models: { execute: 'gpt-5.5' } } },
    });
    const h = makeManager({ ok: true, reply: 'unused' });
    const codex = new GatedBackend([]);
    h.manager.registerBackend('codex', codex);

    const started = h.manager.start('hi', 'codex', 'claude-opus-5-5');
    await waitFor(() => h.manager.get(started.id).state === 'ready');
    expect(started.model).toBe('claude-opus-5-5');
    expect(codex.options?.model).toBe('gpt-5.5');
  });
});

describe('overseer on the bus', () => {
  const WYAT: Sender = { address: 'human:wyat', canDecide: true };

  const gateOfType = (m: Message) =>
    (m.data as { type?: string } | undefined)?.type;

  // Messaging and an overseer manager on it, wired the way index.ts wires them.
  async function openBus(base: Harness, backend: OverseerBackend) {
    const messaging = openMessaging({
      rootDir: repo,
      orchestrator: base.orchestrator,
      store: base.store,
      events: base.events,
      ownerRef: 'human:wyat',
      dbPath: join(repo, 'messages.db'),
    });
    await messaging.recover();
    base.lateMessaging.bind(overseerToolMessaging(messaging.engine));
    ensureOverseerActor(
      messaging.store,
      'agent:wyat/overseer',
      new Date().toISOString()
    );
    const manager = new OverseerManager({
      rootDir: repo,
      registry: base.registry,
      events: base.events,
      bus: createOverseerBus(messaging.engine, messaging.store, {
        owner: 'human:wyat',
        overseer: 'agent:wyat/overseer',
      }),
    });
    manager.registerBackend('fake', backend);
    messaging.bindOverseer(manager);
    return { messaging, manager };
  }

  async function busHarness(
    title = 'Ship the thing',
    speaker: Sender | null = WYAT
  ) {
    const base = makeHarness();
    const taskId = makeTask(base, title);
    const backend = new FakeOverseer({
      ok: true,
      turns: [
        {
          calls: [{ tool: 'dispatch_task', input: { taskId } }],
          reply: 'queued it for you',
        },
        { reply: 'anything else?' },
      ],
    });
    const { messaging, manager } = await openBus(base, backend);
    const started = manager.start(
      'dispatch it',
      'fake',
      undefined,
      undefined,
      speaker
    );
    await waitFor(() => manager.get(started.id).state !== 'running');
    return {
      base,
      taskId,
      messaging,
      manager,
      record: manager.get(started.id),
    };
  }

  it('keeps the conversation as a thread and tags the record entries with message ids', async () => {
    const { messaging, manager, record } = await busHarness();
    await waitFor(() =>
      manager
        .get(record.id)
        .messages.some(
          (m) => m.role === 'assistant' && m.messageId !== undefined
        )
    );
    const current = manager.get(record.id);
    expect(current.thread).toBeDefined();
    const thread = messaging.engine.thread(current.thread ?? '').messages;
    expect(thread.map((m) => [m.from, m.body])).toEqual([
      ['human:wyat', 'dispatch it'],
      ['agent:wyat/overseer', 'queued it for you'],
    ]);
    expect(current.messages[0].messageId).toBe(thread[0].id);
    // The manager consumed the human's line, so it never waits in a mailbox.
    expect(
      messaging.engine.inbox('agent:wyat/overseer').map((i) => i.delivery.state)
    ).toEqual(['read']);
    messaging.close();
  });

  it('turns a queued action into a gate, and confirming it applies the action once', async () => {
    const { base, messaging, record } = await busHarness();
    const gate = messaging.engine
      .openBlocking()
      .find((m) => gateOfType(m) === 'overseer-action');
    expect(gate?.data).toMatchObject({
      conversation: record.id,
      actionId: record.pendingActions[0].id,
    });
    expect(gate?.choices).toEqual(['confirm', 'cancel']);
    await messaging.engine.reply(
      gate?.id ?? '',
      { body: '', choice: 'confirm' },
      { address: 'human:wyat', canDecide: true }
    );
    expect(base.orchestrator.list()).toHaveLength(1);
    if (gate !== undefined) {
      const answer = messaging.engine.answerOf(gate.id);
      // A replay is a no-op.
      if (answer !== null) await messaging.gates.handle(gate, answer);
    }
    expect(base.orchestrator.list()).toHaveLength(1);
    for (const run of base.orchestrator.list())
      await base.orchestrator.cancel(run.id).catch(() => {});
    messaging.close();
  });

  it('a confirm answered "Allow for this conversation" grants the tool', async () => {
    const { base, messaging, manager, record } = await busHarness();
    const gate = messaging.engine
      .openBlocking()
      .find((m) => gateOfType(m) === 'overseer-action');
    // The gate keeps the protocol's two choices; the grant rides on the body.
    expect(gate?.choices).toEqual(['confirm', 'cancel']);
    await messaging.engine.reply(
      gate?.id ?? '',
      { body: OVERSEER_GRANT_ANSWER, choice: 'confirm' },
      { address: 'human:wyat', canDecide: true }
    );
    expect(base.orchestrator.list()).toHaveLength(1);
    expect(manager.listGrants(record.id).map((g) => g.key)).toEqual([
      'overseer action dispatch_task',
    ]);
    for (const run of base.orchestrator.list())
      await base.orchestrator.cancel(run.id).catch(() => {});
    messaging.close();
  });

  it('an auto-run action raises no gate', async () => {
    const base = makeHarness();
    const backend = new FakeOverseer({
      ok: true,
      calls: [{ tool: 'create_task', input: { title: 'No card' } }],
      reply: 'done',
    });
    const { messaging, manager } = await openBus(base, backend);
    const started = manager.start(
      'file it',
      'fake',
      undefined,
      undefined,
      WYAT
    );
    await waitFor(() => manager.get(started.id).state !== 'running');
    expect(
      messaging.engine
        .openBlocking()
        .filter((m) => gateOfType(m) === 'overseer-action')
    ).toEqual([]);
    messaging.close();
  });

  it('closes the action gate when the action is decided another way', async () => {
    const { messaging, manager, record } = await busHarness();
    const gate = messaging.engine
      .openBlocking()
      .find((m) => gateOfType(m) === 'overseer-action');
    if (gate === undefined) throw new Error('no overseer-action gate');
    await manager.confirmAction(
      record.id,
      record.pendingActions[0].id,
      false,
      'human:wyat'
    );
    expect(messaging.engine.answerOf(gate.id)?.data).toMatchObject({
      type: 'x-closed',
    });
    messaging.close();
  });

  // A queued cancel whose run is then cancelled out from under it, so applying
  // the action conflicts.
  async function failingCancel() {
    const base = makeHarness();
    const taskId = makeTask(base, 'Long one');
    const meta = await base.orchestrator.dispatch(taskId, 'slow');
    const { messaging, manager } = await openBus(
      base,
      new FakeOverseer({
        ok: true,
        calls: [{ tool: 'cancel_run', input: { runId: meta.id } }],
        reply: 'queued a cancel',
      })
    );
    const started = manager.start(
      'cancel it',
      'fake',
      undefined,
      undefined,
      WYAT
    );
    await waitFor(() => manager.get(started.id).state !== 'running');
    await base.orchestrator.cancel(meta.id);
    const gate = messaging.engine
      .openBlocking()
      .find((m) => gateOfType(m) === 'overseer-action');
    if (gate === undefined) throw new Error('no overseer-action gate');
    return { messaging, manager, record: manager.get(started.id), gate };
  }

  it('reports a failed apply once and does not raise the gate again', async () => {
    const { messaging, manager, record, gate } = await failingCancel();

    await messaging.engine.reply(
      gate.id,
      { body: '', choice: 'confirm' },
      WYAT
    );

    expect(
      messaging.engine
        .openBlocking()
        .filter((m) => gateOfType(m) === 'overseer-action')
    ).toEqual([]);
    const after = manager.get(record.id);
    expect(after.pendingActions).toEqual([]);
    expect(
      after.messages.filter(
        (m) => m.role === 'action' && m.outcome === 'failed'
      )
    ).toHaveLength(1);
    messaging.close();
  });

  it('a failed confirm made directly settles the action, so a second confirm is refused', async () => {
    const { messaging, manager, record, gate } = await failingCancel();
    const actionId = record.pendingActions[0].id;

    await expect(
      manager.confirmAction(record.id, actionId, true, 'human:wyat')
    ).rejects.toThrow();

    expect(messaging.engine.answerOf(gate.id)?.data).toMatchObject({
      type: 'x-closed',
    });
    expect(
      messaging.engine
        .openBlocking()
        .filter((m) => gateOfType(m) === 'overseer-action')
    ).toEqual([]);
    await expect(
      manager.confirmAction(record.id, actionId, true, 'human:wyat')
    ).rejects.toThrow(/no action awaiting confirmation/);
    messaging.close();
  });

  it('the boot sweep closes conversation gates, since queued actions do not survive a restart', async () => {
    const { messaging } = await busHarness();
    expect(
      closeOrphanedGates(messaging.engine, {
        isRunLive: () => false,
        taskIdOfRun: () => null,
      })
    ).toBeGreaterThan(0);
    expect(
      messaging.engine
        .openBlocking()
        .filter((m) => gateOfType(m) === 'overseer-action')
    ).toEqual([]);
    messaging.close();
  });

  it('a turn with no human speaker runs but puts nothing on the bus', async () => {
    const { messaging, manager, record } = await busHarness(
      'Ship the thing',
      null
    );
    expect(
      manager.get(record.id).messages.some((m) => m.role === 'assistant')
    ).toBe(true);
    expect(manager.get(record.id).thread).toBeUndefined();
    expect(
      messaging.engine
        .inbox('human:wyat')
        .filter((i) => i.message.from === 'agent:wyat/overseer')
    ).toEqual([]);
    messaging.close();
  });

  it('a revoked overseer refuses new messages until it is approved again', async () => {
    const { messaging, manager, record } = await busHarness();
    const agent = messaging.store.getAgent('agent:wyat/overseer');
    if (agent !== null)
      messaging.store.putAgent({
        ...agent,
        status: 'revoked',
        approvedBy: null,
      });
    expect(() => manager.sendMessage(record.id, 'still there?', WYAT)).toThrow(
      OrchestratorConflictError
    );
    let refused: OrchestratorConflictError | undefined;
    try {
      manager.sendMessage(record.id, 'still there?', WYAT);
    } catch (err) {
      refused = err as OrchestratorConflictError;
    }
    expect(refused?.message).toBe('the overseer is revoked');
    expect(refused?.code).toBe('overseer_revoked');
    // Only a caller who can turn it back on is told how (the router decides).
    expect(refused?.operatorHint).toBe(
      'approve agent:wyat/overseer in Settings → Connected agents to use it again'
    );
    ensureOverseerActor(
      messaging.store,
      'agent:wyat/overseer',
      new Date().toISOString()
    );
    // A restart does not re-approve.
    expect(messaging.store.getAgent('agent:wyat/overseer')?.status).toBe(
      'revoked'
    );
    messaging.close();
  });

  it('an overseer whose record is pending, not approved, stays off', async () => {
    const { messaging, manager, record } = await busHarness();
    const agent = messaging.store.getAgent('agent:wyat/overseer');
    if (agent === null) throw new Error('no overseer record');
    messaging.store.putAgent({ ...agent, status: 'pending', approvedBy: null });
    expect(() => manager.sendMessage(record.id, 'still there?', WYAT)).toThrow(
      OrchestratorConflictError
    );
    expect(() =>
      manager.start('hello', 'fake', undefined, undefined, WYAT)
    ).toThrow(OrchestratorConflictError);
    messaging.close();
  });

  it('a human line the bus refuses gets no reply on the bus either', async () => {
    const base = makeHarness();
    const { messaging, manager } = await openBus(
      base,
      new FakeOverseer({ ok: true, reply: 'hi' })
    );
    // The turn is over and its reply has landed on the bus.
    const tagged = (id: string) =>
      manager.get(id).state !== 'running' &&
      manager.get(id).messages.at(-1)?.messageId !== undefined;
    const started = manager.start('hello', 'fake', undefined, undefined, WYAT);
    await waitFor(() => tagged(started.id));

    // A request-tier teammate is no participant of the owner's thread.
    const ALICE: Sender = { address: 'human:alice', canDecide: false };
    manager.sendMessage(started.id, 'hello from alice', ALICE);
    await waitFor(() => manager.get(started.id).state !== 'running');
    // Posts land in order, so once this turn is tagged alice's have settled.
    manager.sendMessage(started.id, 'and now?', WYAT);
    await waitFor(() => tagged(started.id));

    const current = manager.get(started.id);
    const thread = messaging.engine.thread(current.thread ?? '').messages;
    expect(thread.map((m) => [m.from, m.to, m.body])).toEqual([
      ['human:wyat', ['agent:wyat/overseer'], 'hello'],
      ['agent:wyat/overseer', ['human:wyat'], 'hi'],
      ['human:wyat', ['agent:wyat/overseer'], 'and now?'],
      ['agent:wyat/overseer', ['human:wyat'], 'hi'],
    ]);
    expect(
      current.messages.slice(2, 4).map((m) => [m.role, m.text, m.messageId])
    ).toEqual([
      ['user', 'hello from alice', undefined],
      ['assistant', 'hi', undefined],
    ]);
    messaging.close();
  });

  it('an answer to a gate whose conversation is gone is marked applied and the answerer told', async () => {
    const { messaging } = await busHarness();
    const gate = messaging.engine
      .openBlocking()
      .find((m) => gateOfType(m) === 'overseer-action');
    if (gate === undefined) throw new Error('no overseer-action gate');
    const orphan: Message = {
      ...gate,
      data: { ...(gate.data as object), conversation: 'wc-gone' } as JsonValue,
    };
    const answer: Message = {
      ...gate,
      id: 'm-conf',
      replyTo: gate.id,
      kind: 'answer',
      from: 'human:wyat',
      to: ['agent:dispatch'],
      blocking: false,
      choice: 'confirm',
    };
    await expect(
      messaging.gates.handle(orphan, answer)
    ).resolves.toBeUndefined();
    const notices = messaging.engine
      .inbox('human:wyat')
      .filter((i) => i.message.kind === 'notice');
    expect(notices.map((i) => i.message.body)).toEqual([
      'Not applied: overseer conversation wc-gone is gone (the daemon restarted).',
    ]);
    messaging.close();
  });

  it('asks about a parked built-in call through a tool-approval gate', async () => {
    const base = makeHarness();
    const gated = new GatedBackend([
      { toolName: 'Bash', input: { command: 'git status' } },
    ]);
    const { messaging, manager } = await openBus(base, gated);
    const started = manager.start(
      'what changed?',
      'fake',
      undefined,
      undefined,
      WYAT
    );
    await waitFor(() =>
      messaging.engine
        .openBlocking()
        .some((m) => gateOfType(m) === 'tool-approval')
    );
    const gate = messaging.engine
      .openBlocking()
      .find((m) => gateOfType(m) === 'tool-approval');
    expect(gate?.data).toEqual({
      type: 'tool-approval',
      requestId: 'req-1',
      conversation: started.id,
      tool: 'Bash',
      input: { command: 'git status' },
      floor: false,
    });
    expect(gate?.choices).toEqual(['approve', 'approve-session', 'deny']);

    await messaging.engine.reply(
      gate?.id ?? '',
      { body: '', choice: 'approve-session' },
      WYAT
    );
    await waitFor(() => manager.get(started.id).state === 'ready');
    expect(gated.decisions).toEqual([
      { toolName: 'Bash', allow: true, scope: 'session' },
    ]);
    messaging.close();
  });

  it('denies a parked built-in call whose gate cannot be written', async () => {
    const base = makeHarness();
    const gated = new GatedBackend([
      { toolName: 'Bash', input: { command: 'git status' } },
    ]);
    const { messaging, manager } = await openBus(base, gated);
    const send = messaging.engine.send.bind(messaging.engine);
    spyOn(messaging.engine, 'send').mockImplementation((input, sender) =>
      (input.data as { type?: string } | undefined)?.type === 'tool-approval'
        ? Promise.reject(new Error('disk full'))
        : send(input, sender)
    );
    const started = manager.start('hi', 'fake', undefined, undefined, WYAT);
    await waitFor(() => manager.get(started.id).state === 'ready');
    expect(gated.decisions).toEqual([
      {
        toolName: 'Bash',
        allow: false,
        reason: 'Dispatch could not ask a human: disk full',
      },
    ]);
    messaging.close();
  });

  it('closes the tool-approval gate of a call its turn stopped waiting on', async () => {
    const base = makeHarness();
    const dying: OverseerBackend = {
      start: async (_prompt, _toolset, options) => {
        void options?.authorizeTool?.({
          requestId: 'req-x',
          toolName: 'Bash',
          input: { command: 'ls' },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error('session crashed');
      },
      sendMessage: () => Promise.reject(new Error('unused')),
    };
    const { messaging, manager } = await openBus(base, dying);
    const started = manager.start('hi', 'fake', undefined, undefined, WYAT);
    await waitFor(() => manager.get(started.id).state === 'failed');
    const gate = messaging.engine
      .inbox('human:wyat')
      .find((i) => gateOfType(i.message) === 'tool-approval')?.message;
    if (gate === undefined) throw new Error('no tool-approval gate');
    await waitFor(() => messaging.engine.answerOf(gate.id) !== null);
    expect(messaging.engine.answerOf(gate.id)?.data).toMatchObject({
      type: 'x-closed',
    });
    messaging.close();
  });

  describe('questions (AskUserQuestion)', () => {
    const library: OverseerQuestion = {
      question: 'Which library should we use?',
      header: 'Library',
      options: [
        { label: 'date-fns', description: 'Small, functional' },
        { label: 'moment', description: 'Time zones built in' },
      ],
      multiSelect: false,
    };
    const checks: OverseerQuestion = {
      question: 'Which checks should run?',
      header: 'Checks',
      options: [
        { label: 'lint', description: '' },
        { label: 'tests', description: '' },
      ],
      multiSelect: true,
    };

    const openQuestions = (messaging: {
      engine: { openBlocking(): Message[] };
    }) =>
      messaging.engine
        .openBlocking()
        .filter((m) => m.from === 'agent:wyat/overseer');

    it('asks each question of its owner, and an answer under Needs you reaches the session', async () => {
      const base = makeHarness();
      const asking = new AskingBackend([library, checks]);
      const { messaging, manager } = await openBus(base, asking);
      const started = manager.start('pick for me', 'fake');
      await waitFor(() => openQuestions(messaging).length === 2);

      const [single, multi] = openQuestions(messaging);
      // A single choice offers its options as buttons; no gate, so text answers too.
      expect(single?.choices).toEqual(['date-fns', 'moment']);
      expect(single?.body).toContain('moment: Time zones built in');
      expect(gateOfType(single)).toBeUndefined();
      expect(single?.data).toEqual({
        overseerQuestion: {
          conversation: started.id,
          requestId: 'ask-1',
          index: 0,
        },
      });
      // Several at once can only be typed.
      expect(multi?.choices).toBeUndefined();
      expect(manager.get(started.id).pendingApprovals).toEqual([]);

      await messaging.engine.reply(
        single.id,
        { body: 'moment', choice: 'moment' },
        WYAT
      );
      await waitFor(
        () =>
          manager.get(started.id).pendingQuestions?.[0]?.answers[
            library.question
          ] === 'moment'
      );
      // One of two answered: the call still waits.
      expect(asking.answers).toEqual([]);

      await messaging.engine.reply(multi.id, { body: 'lint, tests' }, WYAT);
      await waitFor(() => manager.get(started.id).state === 'ready');
      expect(asking.answers).toEqual([
        {
          answered: true,
          answers: {
            [library.question]: 'moment',
            [checks.question]: 'lint, tests',
          },
        },
      ]);
      expect(openQuestions(messaging)).toEqual([]);
      expect(manager.get(started.id).pendingQuestions).toEqual([]);
    });

    it("counts only the asked human's answer, and asks again after anyone else's", async () => {
      const base = makeHarness();
      const asking = new AskingBackend([library]);
      const { messaging, manager } = await openBus(base, asking);
      const started = manager.start('pick for me', 'fake');
      await waitFor(() => openQuestions(messaging).length === 1);
      const [first] = openQuestions(messaging);
      // Another human's reply is accepted by the engine and uses up the
      // message, but it settles nothing: the question is asked again.
      const SAM: Sender = { address: 'human:sam', canDecide: true };
      await messaging.engine.reply(first.id, { body: 'moment' }, SAM);
      await waitFor(() => {
        const ids = manager.get(started.id).pendingQuestions?.[0]?.messageIds;
        return ids?.[0] != null && ids[0] !== first.id;
      });
      expect(asking.answers).toEqual([]);
      expect(manager.get(started.id).pendingQuestions?.[0]?.answers).toEqual(
        {}
      );
      const [open] = openQuestions(messaging);
      await messaging.engine.reply(open.id, { body: 'date-fns' }, WYAT);
      await waitFor(() => manager.get(started.id).state === 'ready');
      expect(asking.answers).toEqual([
        { answered: true, answers: { [library.question]: 'date-fns' } },
      ]);
    });

    it('closes the questions it asked when the turn stops unanswered', async () => {
      const base = makeHarness();
      const asking = new AskingBackend([library]);
      const { messaging, manager } = await openBus(base, asking);
      const started = manager.start('pick for me', 'fake');
      await waitFor(() => openQuestions(messaging).length === 1);
      manager.stop(started.id);
      await waitFor(() => openQuestions(messaging).length === 0);
      expect(asking.answers).toEqual([
        {
          answered: false,
          reason: 'the turn ended before the human answered',
        },
      ]);
    });
  });
});

describe('an answer pinned to its card', () => {
  it('refuses an answer whose card named a different tool', async () => {
    const h = makeGated([{ toolName: 'Bash', input: { command: 'ls' } }]);
    const started = h.manager.start('look', 'gated');
    await waitFor(() => h.manager.get(started.id).pendingApprovals.length > 0);
    expect(() =>
      h.manager.decideApproval(started.id, 'req-1', { allow: true }, 'Edit')
    ).toThrow('waiting on Bash');
    // The call is still parked for the right card.
    expect(h.manager.get(started.id).pendingApprovals[0]?.requestId).toBe(
      'req-1'
    );
    h.manager.decideApproval(started.id, 'req-1', { allow: false }, 'Bash');
    await waitFor(() => h.manager.get(started.id).state === 'ready');
  });
});

// ---------------------------------------------------------------------------
// One durable conversation: persistence, Stop, the queue, rollover, spend
// ---------------------------------------------------------------------------

// A backend whose turns end when the test says, or when Stop aborts them.
// `options` is what the turn in flight was handed, so a test can speak
// through its live text callbacks.
class HeldBackend implements OverseerBackend {
  readonly prompts: string[] = [];
  readonly resumed: (string | undefined)[] = [];
  options: OverseerTurnOptions | undefined;
  private finish: ((turn: OverseerTurn) => void) | null = null;
  private failTurn: ((error: Error) => void) | null = null;

  start(
    prompt: string,
    _toolset: OverseerToolset,
    options?: OverseerTurnOptions
  ): Promise<OverseerTurn> {
    return this.turn(undefined, prompt, options);
  }

  sendMessage(
    sessionId: string | undefined,
    message: string,
    _toolset: OverseerToolset,
    options?: OverseerTurnOptions
  ): Promise<OverseerTurn> {
    return this.turn(sessionId, message, options);
  }

  // Ends the turn in flight with this reply.
  settle(turn: Partial<OverseerTurn> = {}): void {
    const finish = this.finish;
    this.finish = null;
    finish?.({ reply: 'ok', sessionId: 's-1', ...turn });
  }

  // Fails the turn in flight, as a backend whose model went away does.
  fail(message: string): void {
    const fail = this.failTurn;
    this.failTurn = null;
    fail?.(new Error(message));
  }

  private turn(
    sessionId: string | undefined,
    prompt: string,
    options?: OverseerTurnOptions
  ): Promise<OverseerTurn> {
    this.resumed.push(sessionId);
    this.prompts.push(prompt);
    this.options = options;
    return new Promise((resolve, reject) => {
      this.finish = resolve;
      this.failTurn = reject;
      options?.abortController?.signal.addEventListener('abort', () =>
        reject(new Error('aborted'))
      );
    });
  }
}

function heldManager(store = fileOverseerStore(overseerDir(repo))) {
  const h = makeHarness();
  const backend = new HeldBackend();
  const manager = new OverseerManager({
    rootDir: repo,
    registry: h.registry,
    events: h.events,
    store,
  });
  manager.registerBackend('held', backend);
  return { ...h, manager, backend, store };
}

describe('Overseer tool rows', () => {
  // The record's tool rows, as `tool:status:toolUseId`.
  const toolRows = (record: OverseerRecord) =>
    record.messages
      .filter((m) => m.role === 'tool')
      .map((m) => `${m.tool}:${m.status ?? ''}:${m.toolUseId ?? ''}`);
  const changes = (h: { seen: ServerEvent[] }) =>
    h.seen.filter((e) => e.type === 'overseer.changed').length;

  it('a built-in call named by id runs until its result settles the row in place', () => {
    const h = heldManager();
    const started = h.manager.start('look around', 'held');
    const options = h.backend.options;
    options?.onToolUse?.('Bash', { command: 'git status' }, 'toolu_1');
    options?.onToolUse?.('Edit', { file_path: 'a.ts' }, 'toolu_2');
    const running = h.manager.get(started.id);
    expect(running.messages.at(-2)).toEqual({
      role: 'tool',
      tool: 'Bash',
      text: 'Bash: git status',
      toolUseId: 'toolu_1',
      status: 'running',
      at: expect.any(String),
    });

    const before = changes(h);
    options?.onToolResult?.('toolu_1', 'done');
    expect(changes(h)).toBe(before + 1);
    options?.onToolResult?.('toolu_2', 'error');
    const settled = h.manager.get(started.id);
    // Settled where they stood: no row was added.
    expect(settled.messages).toHaveLength(running.messages.length);
    expect(toolRows(settled)).toEqual([
      'Bash:done:toolu_1',
      'Edit:error:toolu_2',
    ]);
  });

  it('a result for a call the turn is not running changes nothing', () => {
    const h = heldManager();
    const started = h.manager.start('look around', 'held');
    const options = h.backend.options;
    options?.onToolUse?.('Bash', { command: 'ls' }, 'toolu_1');
    options?.onToolResult?.('toolu_1', 'done');
    const before = changes(h);
    // An id never reported, and a second result for one already settled.
    options?.onToolResult?.('toolu_9', 'error');
    options?.onToolResult?.('toolu_1', 'error');
    expect(changes(h)).toBe(before);
    expect(toolRows(h.manager.get(started.id))).toEqual(['Bash:done:toolu_1']);
  });

  it('a call reported without an id has no status, as before', () => {
    const h = heldManager();
    const started = h.manager.start('look around', 'held');
    h.backend.options?.onToolUse?.('Bash', { command: 'ls' });
    expect(toolRows(h.manager.get(started.id))).toEqual(['Bash::']);
  });

  it('a call still running when the turn stops ends with it, and a late result changes nothing', async () => {
    const h = heldManager();
    const started = h.manager.start('look around', 'held');
    const options = h.backend.options;
    options?.onToolUse?.('Bash', { command: 'sleep 60' }, 'toolu_1');
    h.manager.stop(started.id);
    await waitFor(() => h.manager.get(started.id).state === 'ready');
    expect(toolRows(h.manager.get(started.id))).toEqual(['Bash:done:toolu_1']);

    options?.onToolResult?.('toolu_1', 'error');
    // The next turn's calls are its own: the stopped turn's id is not one,
    // and its row does not run again while the next turn does.
    h.manager.sendMessage(started.id, 'go on');
    h.backend.options?.onToolResult?.('toolu_1', 'error');
    h.backend.options?.onToolUse?.('Read', { file_path: 'a.ts' }, 'toolu_2');
    const record = h.manager.get(started.id);
    expect(record.state).toBe('running');
    expect(toolRows(record)).toEqual([
      'Bash:done:toolu_1',
      'Read:running:toolu_2',
    ]);
  });

  it('a turn that fails or replies before a call settles ends that call too', async () => {
    const h = heldManager();
    const started = h.manager.start('look around', 'held');
    h.backend.options?.onToolUse?.('Bash', { command: 'make' }, 'toolu_1');
    h.backend.fail('model went away');
    await waitFor(() => h.manager.get(started.id).state === 'failed');
    expect(toolRows(h.manager.get(started.id))).toEqual(['Bash:done:toolu_1']);

    h.manager.sendMessage(started.id, 'again');
    h.backend.options?.onToolUse?.('Bash', { command: 'make' }, 'toolu_2');
    h.backend.settle({ reply: 'built' });
    await waitFor(() => h.manager.get(started.id).state === 'ready');
    expect(toolRows(h.manager.get(started.id))).toEqual([
      'Bash:done:toolu_1',
      'Bash:done:toolu_2',
    ]);
  });

  it('a call running when the daemon died loads as ended', () => {
    const h = heldManager();
    const started = h.manager.start('look around', 'held');
    h.backend.options?.onToolUse?.('Bash', { command: 'sleep 60' }, 'toolu_1');

    const again = heldManager(h.store);
    const loaded = again.manager.get(started.id);
    expect(loaded.state).toBe('failed');
    expect(toolRows(loaded)).toEqual(['Bash:done:toolu_1']);
  });
});

describe('one durable conversation', () => {
  it('survives the daemon: a settled conversation loads back whole', async () => {
    const h = heldManager();
    const started = h.manager.start('hello', 'held');
    h.backend.settle({ reply: 'hi', costUsd: 0.25 });
    await waitFor(() => h.manager.get(started.id).state === 'ready');

    const again = heldManager(h.store);
    const loaded = again.manager.get(started.id);
    expect(loaded.state).toBe('ready');
    expect(loaded.messages.map((m) => m.text)).toEqual(['hello', 'hi']);
    expect(loaded.spendUsd).toBe(0.25);
    expect(loaded.messages[1].costUsd).toBe(0.25);
  });

  it('a turn the daemon died in loads as failed, behind a restarted notice', () => {
    const h = heldManager();
    const started = h.manager.start('hello', 'held');

    const again = heldManager(h.store);
    const loaded = again.manager.get(started.id);
    expect(loaded.state).toBe('failed');
    expect(loaded.pendingApprovals).toEqual([]);
    expect(loaded.messages.at(-1)).toMatchObject({
      role: 'notice',
      notice: 'restarted',
    });
  });

  // A conversation that queued `dispatch_task`, saved to a file store, and the
  // manager the next daemon builds over that store: a fresh registry, as
  // index.ts makes one per boot, so the action it queued is not in it.
  async function queuedThenRestarted(settle: boolean) {
    const h = makeHarness();
    const taskId = makeTask(h, 'Ship it');
    const store = fileOverseerStore(overseerDir(repo));
    const manager = new OverseerManager({
      rootDir: repo,
      registry: h.registry,
      events: h.events,
      store,
    });
    const held = new HeldBackend();
    manager.registerBackend('fake', {
      start: async (prompt, toolset, options) => {
        await toolset.call('dispatch_task', { taskId });
        return held.start(prompt, toolset, options);
      },
      sendMessage: (sessionId, message, toolset, options) =>
        held.sendMessage(sessionId, message, toolset, options),
    });
    const started = manager.start('dispatch it', 'fake');
    await waitFor(() => manager.get(started.id).pendingActions.length === 1);
    if (settle) {
      held.settle({ reply: 'queued it' });
      await waitFor(() => manager.get(started.id).state === 'ready');
    }
    const [action] = manager.get(started.id).pendingActions;
    const again = new OverseerManager({
      rootDir: repo,
      registry: new OverseerToolRegistry(h),
      events: h.events,
      store,
    });
    return { h, store, action, id: started.id, again };
  }

  it('an action queued before a restart loads as dropped, not as a card nothing can answer', async () => {
    const { h, store, action, id, again } = await queuedThenRestarted(true);
    const loaded = again.get(id);
    expect(loaded.state).toBe('ready');
    expect(loaded.pendingActions).toEqual([]);
    expect(loaded.messages.at(-1)).toEqual({
      role: 'action',
      tool: 'dispatch_task',
      actionId: action.id,
      outcome: 'denied',
      text: `Denied: ${action.summary} — Dispatch restarted before anyone decided`,
      at: expect.any(String),
    });
    // The model hears it on the next turn, so it never says the action waits.
    expect(loaded.undeliveredDecisions).toEqual([
      `${action.summary} — nobody decided this before Dispatch restarted, so it was dropped. It did not happen.`,
    ]);
    expect(h.orchestrator.list()).toEqual([]);

    // Written through: the boot after that has nothing left to drop.
    const third = new OverseerManager({
      rootDir: repo,
      registry: new OverseerToolRegistry(h),
      events: h.events,
      store,
    });
    expect(third.get(id).messages).toEqual(loaded.messages);
  });

  it('a turn that died with an action queued loads as restarted, the action dropped after the notice', async () => {
    const { action, id, again } = await queuedThenRestarted(false);
    const loaded = again.get(id);
    expect(loaded.state).toBe('failed');
    expect(loaded.pendingActions).toEqual([]);
    expect(
      loaded.messages.map((m) => `${m.role}:${m.notice ?? m.outcome ?? ''}`)
    ).toEqual(['user:', 'action:pending', 'notice:restarted', 'action:denied']);
    expect(loaded.messages.at(-1)?.actionId).toBe(action.id);
  });

  it('daemon shutdown aborts the running turn and leaves it for the next boot', async () => {
    const h = heldManager();
    const started = h.manager.start('do a long thing', 'held');
    h.manager.shutdown();
    await tick();
    // The backend saw the abort (its child dies with the daemon), but nothing
    // is written past shutdown: the next boot marks the turn restarted.
    expect(h.manager.get(started.id).state).toBe('running');
    const again = heldManager(h.store);
    expect(again.manager.get(started.id).messages.at(-1)).toMatchObject({
      notice: 'restarted',
    });
  });

  it('Stop ends the turn as stopped, not failed', async () => {
    const h = heldManager();
    const started = h.manager.start('do a long thing', 'held');
    h.manager.stop(started.id);
    await waitFor(() => h.manager.get(started.id).state !== 'running');
    const record = h.manager.get(started.id);
    expect(record.state).toBe('ready');
    expect(record.error).toBeUndefined();
    expect(record.messages.at(-1)).toMatchObject({
      role: 'notice',
      notice: 'stopped',
    });
  });

  it('a message typed mid-turn queues, then goes out when the turn ends', async () => {
    const h = heldManager();
    const started = h.manager.start('first', 'held');
    const queued = h.manager.sendMessage(started.id, 'and also this');
    expect(queued.state).toBe('running');
    expect(queued.queued?.map((q) => q.text)).toEqual(['and also this']);
    expect(queued.messages.map((m) => m.text)).toEqual(['first']);

    h.backend.settle();
    await waitFor(() => h.backend.prompts.length === 2);
    expect(h.backend.prompts[1]).toBe('and also this');
    const record = h.manager.get(started.id);
    expect(record.state).toBe('running');
    expect(record.queued).toEqual([]);
    expect(record.messages.map((m) => m.text)).toEqual([
      'first',
      'ok',
      'and also this',
    ]);
  });

  it('after Stop, the queue waits and goes out with the next message', async () => {
    const h = heldManager();
    const started = h.manager.start('first', 'held');
    h.manager.sendMessage(started.id, 'queued one');
    h.manager.stop(started.id);
    await waitFor(() => h.manager.get(started.id).state === 'ready');
    expect(h.backend.prompts).toHaveLength(1);

    h.manager.sendMessage(started.id, 'now this');
    expect(h.backend.prompts[1]).toBe('queued one\n\nnow this');
  });

  it('an edited queued message goes out as edited, a removed one not at all', async () => {
    const h = heldManager();
    const started = h.manager.start('first', 'held');
    h.manager.sendMessage(started.id, 'teh typo');
    const queued = h.manager.sendMessage(started.id, 'never mind this');
    const [typo, drop] = queued.queued ?? [];
    expect(typo.id).not.toBe(drop.id);

    h.manager.editQueued(started.id, typo.id, 'the fix');
    const after = h.manager.removeQueued(started.id, drop.id);
    expect(after.queued?.map((q) => q.text)).toEqual(['the fix']);
    // Nothing reaches the agent before the turn ends.
    expect(h.backend.prompts).toEqual(['first']);

    h.backend.settle();
    await waitFor(() => h.backend.prompts.length === 2);
    expect(h.backend.prompts[1]).toBe('the fix');
    expect(h.manager.get(started.id).messages.map((m) => m.text)).toEqual([
      'first',
      'ok',
      'the fix',
    ]);
  });

  it('a queue emptied by removes sends nothing when the turn ends', async () => {
    const h = heldManager();
    const started = h.manager.start('first', 'held');
    const queued = h.manager.sendMessage(started.id, 'one');
    h.manager.removeQueued(started.id, queued.queued?.[0].id ?? '');

    h.backend.settle();
    await waitFor(() => h.manager.get(started.id).state === 'ready');
    await tick();
    expect(h.backend.prompts).toEqual(['first']);
    expect(h.manager.get(started.id).messages.map((m) => m.text)).toEqual([
      'first',
      'ok',
    ]);
  });

  it('an edit or remove after the queue went out is a 409, an unknown id a 404', async () => {
    const h = heldManager();
    const started = h.manager.start('first', 'held');
    const entry = h.manager.sendMessage(started.id, 'late').queued?.[0];
    h.backend.settle();
    await waitFor(() => h.backend.prompts.length === 2);

    expect(() =>
      h.manager.editQueued(started.id, entry?.id ?? '', 'too late')
    ).toThrow(OrchestratorConflictError);
    expect(() => h.manager.removeQueued(started.id, entry?.id ?? '')).toThrow(
      /already sent/
    );
    expect(() => h.manager.editQueued(started.id, 'q-nope', 'x')).toThrow(
      OrchestratorNotFoundError
    );
    expect(h.backend.prompts[1]).toBe('late');
  });

  it('a message left waiting behind a slash command keeps its id', async () => {
    const h = heldManager();
    const started = h.manager.start('first', 'held');
    h.manager.sendMessage(started.id, '/compact');
    const after = h.manager.sendMessage(started.id, 'then this').queued?.[1];

    h.backend.settle();
    await waitFor(() => h.backend.prompts.length === 2);
    expect(h.backend.prompts[1]).toBe('/compact');
    expect(h.manager.get(started.id).queued).toEqual([after!]);
    h.manager.editQueued(started.id, after?.id ?? '', 'then that');

    h.backend.settle();
    await waitFor(() => h.backend.prompts.length === 3);
    expect(h.backend.prompts[2]).toBe('then that');
  });

  it('a queue saved without ids gets them on load', () => {
    const h = heldManager();
    const started = h.manager.start('first', 'held');
    h.store.save({
      ...h.manager.get(started.id),
      state: 'ready',
      queued: [{ text: 'old', at: started.createdAt }],
    } as unknown as OverseerRecord);
    const again = heldManager(h.store);
    const entry = again.manager.get(started.id).queued?.[0];
    expect(entry?.id).toMatch(/^q-/);
    again.manager.editQueued(started.id, entry?.id ?? '', 'renewed');
    expect(again.manager.get(started.id).queued?.[0].text).toBe('renewed');
  });

  it('a full context rolls over: fresh session, recap, divider, grants gone', async () => {
    const h = heldManager();
    const started = h.manager.start('first', 'held');
    h.backend.settle({ reply: 'answer one', contextTokens: ROLLOVER_TOKENS });
    await waitFor(() => h.manager.get(started.id).state === 'ready');

    h.manager.sendMessage(started.id, 'next');
    expect(h.backend.resumed[1]).toBeUndefined();
    expect(h.backend.prompts[1]).toContain('Human: first');
    expect(h.backend.prompts[1]).toContain('You: answer one');
    expect(h.backend.prompts[1].endsWith('next')).toBe(true);
    const record = h.manager.get(started.id);
    expect(record.messages.at(-2)).toMatchObject({
      role: 'notice',
      notice: 'rollover',
    });
  });

  it('under the threshold the session resumes', async () => {
    const h = heldManager();
    const started = h.manager.start('first', 'held');
    h.backend.settle({ contextTokens: ROLLOVER_TOKENS - 1 });
    await waitFor(() => h.manager.get(started.id).state === 'ready');
    h.manager.sendMessage(started.id, 'next');
    expect(h.backend.resumed[1]).toBe('s-1');
    expect(h.backend.prompts[1]).toBe('next');
  });

  it('current is the newest conversation its owner opened', () => {
    const h = heldManager();
    const ada: Sender = { address: 'human:ada', canDecide: true };
    const bo: Sender = { address: 'human:bo', canDecide: true };
    h.manager.start('ada one', 'held', undefined, undefined, ada);
    h.manager.start('bo one', 'held', undefined, undefined, bo);
    expect(h.manager.current('human:ada')?.prompt).toBe('ada one');
    expect(h.manager.current('human:bo')?.prompt).toBe('bo one');
    expect(h.manager.current('human:cy')).toBeUndefined();
  });
});

describe('a conversation reads as its owner', () => {
  it('hands the owner to a status tool and keeps its words out of the transcript', async () => {
    const h = makeHarness();
    let seenOwner: string | undefined;
    h.lateMessaging.bind({
      answerRunApproval: () => Promise.resolve(),
      sendAsHuman: () => Promise.resolve(),
      readAs: (reader) => {
        seenOwner = reader;
        return [];
      },
    });
    const backend = new FakeOverseer({
      ok: true,
      calls: [{ tool: 'read_conversation', input: { with: 'human:sam' } }],
      reply: 'nothing new',
    });
    const manager = new OverseerManager({
      rootDir: repo,
      registry: h.registry,
      events: h.events,
    });
    manager.registerBackend('fake', backend);
    const started = manager.start(
      'any news from sam?',
      'fake',
      undefined,
      undefined,
      {
        address: 'human:wyat',
        canDecide: true,
      }
    );
    await waitFor(() => manager.get(started.id).state !== 'running');
    expect(seenOwner).toBe('human:wyat');
    expect(
      manager.get(started.id).messages.find((m) => m.role === 'tool')?.text
    ).toBe('read 0 messages (kept out of this transcript)');
  });
});

describe('slash commands', () => {
  it('go to the session verbatim, keeping undelivered decisions for later', async () => {
    const h = heldManager();
    const started = h.manager.start('first', 'held');
    h.backend.settle({
      commands: [{ name: 'compact', description: 'Compact', argumentHint: '' }],
    });
    await waitFor(() => h.manager.get(started.id).state === 'ready');
    expect(h.manager.get(started.id).commands?.map((c) => c.name)).toEqual([
      'compact',
    ]);
    // A decision the model has not heard about yet.
    (
      h.manager.get(started.id) as { undeliveredDecisions: string[] }
    ).undeliveredDecisions.push('approved: cancel r-1');

    h.manager.sendMessage(started.id, '/compact');
    expect(h.backend.prompts[1]).toBe('/compact');
    expect(h.manager.get(started.id).undeliveredDecisions).toEqual([
      'approved: cancel r-1',
    ]);
  });

  it('never ride along with plain messages: a slash command is its own turn', async () => {
    const h = heldManager();
    const started = h.manager.start('first', 'held');
    h.manager.sendMessage(started.id, 'one');
    h.manager.sendMessage(started.id, '/compact');
    h.manager.sendMessage(started.id, 'two');
    h.backend.settle();
    await waitFor(() => h.backend.prompts.length === 2);
    expect(h.backend.prompts[1]).toBe('one');
    h.backend.settle();
    await waitFor(() => h.backend.prompts.length === 3);
    expect(h.backend.prompts[2]).toBe('/compact');
    h.backend.settle();
    await waitFor(() => h.backend.prompts.length === 4);
    expect(h.backend.prompts[3]).toBe('two');
  });
});

// ---------------------------------------------------------------------------
// Live text: what a running turn streams, and the narration it leaves
// ---------------------------------------------------------------------------

type DeltaEvent = Extract<ServerEvent, { type: 'overseer.delta' }>;

function deltasOf(h: { seen: ServerEvent[] }): DeltaEvent[] {
  return h.seen.filter((e): e is DeltaEvent => e.type === 'overseer.delta');
}

// Sets `overseer.stream` in the project's config, read afresh every turn.
function streamMode(mode: string): void {
  appendFileSync(
    join(repo, '.dispatch', 'config.yml'),
    `overseer:\n  stream: ${mode}\n`
  );
}

describe('overseer live text', () => {
  it('streams frames whose seq keeps counting across turns, and a snapshot only while running', async () => {
    const h = heldManager();
    const started = h.manager.start('first', 'held');
    h.backend.options?.onTextDelta?.('m1:0', 'Hel');
    h.backend.options?.onTextDelta?.('m1:0', 'lo');
    const [one, two] = deltasOf(h);
    const turnId = one.turnId;
    const segmentId = `${turnId}:m1:0`;
    expect(one).toEqual({
      type: 'overseer.delta',
      conversationId: started.id,
      turnId,
      seq: 1,
      segmentId,
      text: 'Hel',
    });
    expect(two).toMatchObject({ seq: 2, turnId, segmentId, text: 'lo' });
    expect(h.manager.view(h.manager.get(started.id)).live).toEqual({
      seq: 2,
      turnId,
      segments: [{ id: segmentId, text: 'Hello' }],
    });

    h.backend.settle({ reply: 'Hello', streamId: 'm1:0' });
    await waitFor(() => h.manager.get(started.id).state === 'ready');
    const settled = h.manager.view(h.manager.get(started.id));
    expect(settled.live).toBeUndefined();
    expect(settled.messages.at(-1)).toMatchObject({
      role: 'assistant',
      text: 'Hello',
      streamId: segmentId,
    });

    // The next turn reuses the backend's segment id; its frames still differ.
    h.manager.sendMessage(started.id, 'again');
    expect(h.manager.view(h.manager.get(started.id)).live).toMatchObject({
      seq: 2,
      segments: [],
    });
    h.backend.options?.onTextDelta?.('m1:0', 'Again');
    const next = deltasOf(h).at(-1);
    expect(next).toMatchObject({ seq: 3, text: 'Again' });
    expect(next?.turnId).not.toBe(turnId);
    expect(next?.segmentId).toBe(`${next?.turnId}:m1:0`);
  });

  it('lands narration as its own row and takes it out of the live text', async () => {
    const h = heldManager();
    const started = h.manager.start('look around', 'held');
    const options = h.backend.options;
    options?.onTextDelta?.('a', 'Looking.');
    options?.onNarration?.('a', 'Looking.\n');
    options?.onTextDelta?.('b', 'Two runs');
    const turnId = deltasOf(h)[0].turnId;
    expect(h.manager.get(started.id).messages.at(-1)).toEqual({
      role: 'narration',
      text: 'Looking.',
      streamId: `${turnId}:a`,
      at: expect.any(String),
    });
    expect(h.manager.view(h.manager.get(started.id)).live?.segments).toEqual([
      { id: `${turnId}:b`, text: 'Two runs' },
    ]);

    h.backend.settle({ reply: 'Two runs are live.', streamId: 'b' });
    await waitFor(() => h.manager.get(started.id).state === 'ready');
    expect(h.manager.get(started.id).messages.map((m) => m.role)).toEqual([
      'user',
      'narration',
      'assistant',
    ]);
  });

  // Codex's reply is its last message even when a step followed it, and by
  // then that message went out as narration: it must not show twice.
  it('a reply naming a narrated segment takes the place of that row', async () => {
    for (const mode of ['live', 'narration']) {
      const h = heldManager();
      streamMode(mode);
      const started = h.manager.start('status?', 'held');
      const options = h.backend.options;
      options?.onTextDelta?.('m1', 'The tree is clean.');
      options?.onNarration?.('m1', 'The tree is clean.');
      options?.onToolUse?.('codex.commandExecution', { command: 'git status' });
      h.backend.settle({ reply: 'The tree is clean.', streamId: 'm1' });
      await waitFor(() => h.manager.get(started.id).state === 'ready');
      const messages = h.manager.get(started.id).messages;
      expect(messages.map((m) => [m.role, m.text])).toEqual([
        ['user', 'status?'],
        ['tool', expect.any(String)],
        ['assistant', 'The tree is clean.'],
      ]);
      if (mode === 'live') {
        const turnId = deltasOf(h)[0].turnId;
        expect(messages.at(-1)?.streamId).toBe(`${turnId}:m1`);
      }
      rmSync(join(repo, '.dispatch', 'config.yml'));
      TaskStore.init(repo);
    }
  });

  it('Stop keeps the partial text as narration ahead of the notice, and drops what comes after', async () => {
    const h = heldManager();
    const started = h.manager.start('think hard', 'held');
    const options = h.backend.options;
    options?.onTextDelta?.('a', 'Half a thou');
    h.manager.stop(started.id);
    await waitFor(() => h.manager.get(started.id).state !== 'running');
    const turnId = deltasOf(h)[0].turnId;
    expect(
      h.manager.get(started.id).messages.map((m) => [m.role, m.text])
    ).toEqual([
      ['user', 'think hard'],
      ['narration', 'Half a thou'],
      ['notice', 'Stopped'],
    ]);
    expect(h.manager.get(started.id).messages[1].streamId).toBe(`${turnId}:a`);

    // The model keeps talking after Stop settled the turn: none of it lands.
    options?.onTextDelta?.('a', 'ght');
    options?.onNarration?.('a', 'Half a thought');
    expect(deltasOf(h)).toHaveLength(1);
    expect(h.manager.get(started.id).messages).toHaveLength(3);
    expect(h.manager.view(h.manager.get(started.id)).live).toBeUndefined();
  });

  // A Claude block whose stream broke off comes again under a new segment:
  // the half-written one must not stay on screen, nor land as narration.
  it('drops an abandoned segment from the live text, and Stop does not keep it', async () => {
    const h = heldManager();
    const started = h.manager.start('look', 'held');
    const options = h.backend.options;
    options?.onTextDelta?.('a', 'Let me lo');
    options?.onSegmentAbandoned?.('a');
    const turnId = deltasOf(h)[0].turnId;
    expect(deltasOf(h).at(-1)).toEqual({
      type: 'overseer.delta',
      conversationId: started.id,
      turnId,
      seq: 2,
      segmentId: `${turnId}:a`,
      text: '',
      abandoned: true,
    });
    expect(h.manager.view(h.manager.get(started.id)).live).toEqual({
      seq: 2,
      turnId,
      segments: [],
    });
    // A segment that never streamed, or went already, sends nothing.
    options?.onSegmentAbandoned?.('a');
    options?.onSegmentAbandoned?.('never');
    expect(deltasOf(h)).toHaveLength(2);

    options?.onTextDelta?.('b', 'Let me look');
    h.manager.stop(started.id);
    await waitFor(() => h.manager.get(started.id).state !== 'running');
    expect(
      h.manager.get(started.id).messages.map((m) => [m.role, m.text])
    ).toEqual([
      ['user', 'look'],
      ['narration', 'Let me look'],
      ['notice', 'Stopped'],
    ]);
    // After the turn, an abandon changes nothing.
    options?.onSegmentAbandoned?.('b');
    expect(deltasOf(h)).toHaveLength(3);
  });

  it('a failed turn keeps its partial text too', async () => {
    const h = heldManager();
    const started = h.manager.start('go', 'held');
    h.backend.options?.onTextDelta?.('a', 'Starting on');
    h.backend.fail('model down');
    await waitFor(() => h.manager.get(started.id).state === 'failed');
    const record = h.manager.get(started.id);
    expect(record.error).toBe('model down');
    expect(record.messages.at(-1)).toMatchObject({
      role: 'narration',
      text: 'Starting on',
    });
  });

  it('never writes live text to the store', () => {
    const h = heldManager();
    const started = h.manager.start('first', 'held');
    h.backend.options?.onTextDelta?.('a', 'not yet said');
    const file = join(overseerDir(repo), `${started.id}.json`);
    const stored = readFileSync(file, 'utf8');
    expect(stored).not.toContain('not yet said');
    expect(JSON.parse(stored)).not.toHaveProperty('live');
    expect(h.manager.get(started.id)).not.toHaveProperty('live');
    // A restart starts over: the turn loads as restarted, with no live text.
    const again = heldManager(h.store);
    expect(
      again.manager.view(again.manager.get(started.id))
    ).not.toHaveProperty('live');
  });

  it('overseer.stream decides which callbacks a turn gets', async () => {
    const turnOptions = (): OverseerTurnOptions | undefined => {
      const h = heldManager();
      h.manager.start('hi', 'held');
      return h.backend.options;
    };
    const live = turnOptions();
    expect(live?.onTextDelta).toBeFunction();
    expect(live?.onSegmentAbandoned).toBeFunction();
    expect(live?.onNarration).toBeFunction();

    streamMode('narration');
    const h = heldManager();
    const started = h.manager.start('hi', 'held');
    expect(h.backend.options?.onTextDelta).toBeUndefined();
    expect(h.backend.options?.onSegmentAbandoned).toBeUndefined();
    h.backend.options?.onNarration?.('a', 'Checking first.');
    // Nothing streamed, so the row names no stream.
    expect(h.manager.get(started.id).messages.at(-1)).toEqual({
      role: 'narration',
      text: 'Checking first.',
      at: expect.any(String),
    });
    h.backend.settle({ reply: 'done', streamId: 'b' });
    await waitFor(() => h.manager.get(started.id).state === 'ready');
    expect(h.manager.get(started.id).messages.at(-1)).not.toHaveProperty(
      'streamId'
    );

    rmSync(join(repo, '.dispatch', 'config.yml'));
    TaskStore.init(repo);
    streamMode('off');
    const off = turnOptions();
    expect(off?.onTextDelta).toBeUndefined();
    expect(off?.onSegmentAbandoned).toBeUndefined();
    expect(off?.onNarration).toBeUndefined();
  });

  it('sends frames only to the sockets of the live audience', () => {
    const h = heldManager();
    const got = new Map<string, number>();
    const socket = (name: string, data: SocketAudience): BroadcastClient => ({
      data,
      send: (payload) => {
        if ((JSON.parse(payload) as ServerEvent).type === 'overseer.delta') {
          got.set(name, (got.get(name) ?? 0) + 1);
        }
      },
    });
    h.events.add(
      socket('operator', {
        ref: 'human:op',
        tier: 'operator',
        agentToken: false,
      })
    );
    h.events.add(
      socket('agent', { ref: 'human:op', tier: 'operator', agentToken: true })
    );
    h.events.add(
      socket('teammate', {
        ref: 'human:ann',
        tier: 'request',
        agentToken: false,
      })
    );
    h.manager.start('hi', 'held');
    h.backend.options?.onTextDelta?.('a', 'hello');
    h.backend.options?.onSegmentAbandoned?.('a');
    expect(Object.fromEntries(got)).toEqual({ operator: 2 });
  });
});

describe('overseerLiveAudience', () => {
  const who = (
    ref: string | null,
    tier: AuthTier | null,
    agentToken = false
  ): SocketAudience => ({ ref, tier, agentToken });

  // The owner decision of 2026-10-23: any deciding human, plus the owner and
  // the operator tier; never the agent token.
  it.each([
    ['the owner on the request tier', who('human:ann', 'request'), true],
    ['the operator', who('human:op', 'operator'), true],
    ['another deciding human', who('human:bo', 'decide'), true],
    [
      'a request-tier human who is not the owner',
      who('human:cy', 'request'),
      false,
    ],
    ['the shared agent token', who('human:op', 'operator', true), false],
    [
      'an agent with its own decide-tier token',
      who('agent:run-1', 'decide'),
      false,
    ],
    ['a socket nobody resolved', who(null, null), false],
  ] as const)('%s: %p', (_label, audience, hears) => {
    expect(overseerLiveAudience({ owner: 'human:ann' })(audience)).toBe(hears);
  });

  it('reaches only deciding humans and the operator for an unowned conversation', () => {
    const hears = overseerLiveAudience({});
    expect(hears(who('human:bo', 'decide'))).toBe(true);
    expect(hears(who('human:op', 'operator'))).toBe(true);
    expect(hears(who('human:cy', 'request'))).toBe(false);
    expect(hears(who('human:op', 'operator', true))).toBe(false);
    expect(hears(undefined)).toBe(false);
  });
});

// Risk tiers: what runs at once, what asks once, what always asks
// ---------------------------------------------------------------------------

describe('overseer action tiers', () => {
  // A harness whose registry can write tasks, as index.ts wires it.
  function writableHarness(): Harness {
    const base = makeHarness();
    const ctx: OverseerToolContext = {
      ...base,
      tasks: {
        create: (input) => {
          const doc = base.store.create(input);
          base.cache.rebuild(base.store);
          return doc;
        },
        update: (id, patch) => {
          const doc = base.store.update(id, patch);
          base.cache.rebuild(base.store);
          return doc;
        },
      },
    };
    return { ...base, ...ctx, registry: new OverseerToolRegistry(ctx) };
  }

  function managerOn(base: Harness, turns: FakeOverseerTurn[]): ManagerHarness {
    const backend = new FakeOverseer({ ok: true, turns });
    const manager = new OverseerManager({
      rootDir: repo,
      registry: base.registry,
      events: base.events,
    });
    manager.registerBackend('fake', backend);
    return { ...base, manager, backend };
  }

  async function nextTurn(h: ManagerHarness, id: string, text: string) {
    h.manager.sendMessage(id, text);
    await waitFor(() => h.manager.get(id).state !== 'running');
    return h.manager.get(id);
  }

  // Waits out the turn a confirm starts to tell the model what was decided.
  async function settled(h: ManagerHarness, id: string) {
    await waitFor(() => h.manager.get(id).state !== 'running');
    return h.manager.get(id);
  }

  function setAutonomy(level: 'cautious' | 'balanced' | 'trusting') {
    updateConfig(repo, { overseer: { autonomy: level } });
  }

  it('routes each tier by the autonomy setting, and high always asks', () => {
    const table = (['low', 'medium', 'high'] as const).map((tier) => [
      tier,
      overseerActionRoute(tier, 'cautious'),
      overseerActionRoute(tier, 'balanced'),
      overseerActionRoute(tier, 'trusting'),
    ]);
    expect(table).toEqual([
      ['low', 'ask', 'auto', 'auto'],
      ['medium', 'ask', 'ask-once', 'auto'],
      ['high', 'ask', 'ask', 'ask'],
    ]);
  });

  it('gives every mutating tool the tier the policy names', () => {
    const base = makeHarness();
    const tiers = Object.fromEntries(
      base.registry.mutatingTools().map((t) => [t.name, t.tier])
    );
    expect(tiers).toEqual({
      create_task: 'low',
      update_task: 'low',
      create_plan: 'low',
      message_run: 'low',
      dispatch_task: 'medium',
      approve_run: 'medium',
      deny_run: 'medium',
      queue_merge: 'medium',
      dequeue_merge: 'medium',
      cancel_run: 'high',
      discard_run: 'high',
      send_as_you: 'high',
    });
  });

  it('runs a low-tier call at once: no card, a receipt, a done result, an audit entry', async () => {
    const base = writableHarness();
    const h = managerOn(base, [
      {
        calls: [{ tool: 'create_task', input: { title: 'Write the docs' } }],
        reply: 'done',
      },
    ]);
    const record = await startAndSettle(h, 'file a task');

    expect(record.pendingActions).toEqual([]);
    const created = base.store
      .list()
      .find((t) => t.meta.title === 'Write the docs')?.meta;
    expect(created).toBeDefined();
    const receipt = record.messages.find((m) => m.role === 'action');
    expect(receipt).toMatchObject({
      tool: 'create_task',
      outcome: 'applied',
      auto: true,
      tier: 'low',
      taskIds: [created?.id],
    });
    expect(receipt?.text).toStartWith('Done: Create task');
    const told = JSON.stringify(h.backend.observations[0].result.content);
    expect(told).toContain('"done":true');
    expect(told).toContain('ALREADY been carried out');
    expect(told).not.toContain('NOTHING has happened');

    const entries = base.ledgerStore.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'decision',
      sourceTaskId: created?.id,
      authoredBy: 'human:test',
    });
    expect(entries[0].detail).toContain(
      'auto-decided by overseer.autonomy balanced (low tier)'
    );
    expect(classifyLedgerEntry(entries[0]).to).toBe('audit');
    expect(h.seen.some((e) => e.type === 'ledger.changed')).toBe(true);
  });

  it('an update_task receipt carries the diff of every field it changed', async () => {
    const base = writableHarness();
    const blocker = makeTask(base, 'Blocker');
    const parent = makeTask(base, 'Parent');
    const target = base.store.create({
      title: 'Old title',
      description: 'old spec',
    }).meta.id;
    base.cache.rebuild(base.store);
    const h = managerOn(base, [
      {
        calls: [
          {
            tool: 'update_task',
            input: {
              taskId: target,
              title: 'New title',
              description: 'new spec',
              priority: 'high',
              parent,
              blockedBy: [blocker],
            },
          },
        ],
        reply: 'updated',
      },
    ]);
    const record = await startAndSettle(h, 'tidy it up');

    const receipt = record.messages.find((m) => m.role === 'action');
    expect(receipt).toMatchObject({ auto: true, taskIds: [target] });
    expect(receipt?.changes).toEqual([
      { field: 'title', before: 'Old title', after: 'New title' },
      { field: 'description', before: 'old spec', after: 'new spec' },
      { field: 'priority', before: 'none', after: 'high' },
      { field: 'parent', before: 'none', after: parent },
      { field: 'blockedBy', before: 'none', after: blocker },
    ]);
    const doc = base.store.get(target);
    expect(doc?.meta).toMatchObject({
      title: 'New title',
      priority: 'high',
      parent,
      blockedBy: [blocker],
    });
  });

  it('cautious asks about a low-tier call like everything else', async () => {
    setAutonomy('cautious');
    const base = writableHarness();
    const h = managerOn(base, [
      {
        calls: [{ tool: 'create_task', input: { title: 'Held back' } }],
        reply: 'queued',
      },
    ]);
    const record = await startAndSettle(h, 'file a task');

    expect(record.pendingActions).toHaveLength(1);
    expect(record.pendingActions[0].grantable).toBeUndefined();
    expect(base.store.list().some((t) => t.meta.title === 'Held back')).toBe(
      false
    );
    expect(JSON.stringify(h.backend.observations[0].result.content)).toContain(
      'NOTHING has happened yet'
    );
    expect(base.ledgerStore.list()).toEqual([]);
  });

  it('a medium-tier call asks once, and the grant runs the next one without a card', async () => {
    const base = makeHarness();
    const first = makeTask(base, 'First');
    const second = makeTask(base, 'Second');
    const h = managerOn(base, [
      {
        calls: [{ tool: 'dispatch_task', input: { taskId: first } }],
        reply: 'q',
      },
      // The turn the approval wakes, which goes on to the second.
      {
        calls: [{ tool: 'dispatch_task', input: { taskId: second } }],
        reply: 'd',
      },
    ]);
    const opened = await startAndSettle(h, 'dispatch first');
    const action = opened.pendingActions[0];
    expect(action).toMatchObject({ tier: 'medium', grantable: true });

    const decided = await h.manager.confirmAction(
      opened.id,
      action.id,
      true,
      'human:test',
      false,
      'session'
    );
    expect(decided.messages.at(-1)?.text).toContain(
      'dispatch_task allowed for this conversation'
    );
    expect(h.manager.listGrants(opened.id).map((g) => g.key)).toEqual([
      'overseer action dispatch_task',
    ]);

    const after = await settled(h, opened.id);
    expect(after.pendingActions).toEqual([]);
    expect(
      h.orchestrator
        .list()
        .map((r) => r.taskId)
        .sort()
    ).toEqual([first, second].sort());
    expect(after.messages.filter((m) => m.auto === true)).toHaveLength(1);
    const audit = base.ledgerStore.list();
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toContain('a grant for this conversation');
  });

  it('a once answer grants nothing, and a revoked grant asks again', async () => {
    const base = makeHarness();
    const a = makeTask(base, 'A');
    const b = makeTask(base, 'B');
    const c = makeTask(base, 'C');
    const h = managerOn(base, [
      { calls: [{ tool: 'dispatch_task', input: { taskId: a } }], reply: '1' },
      { reply: 'noted' },
      { calls: [{ tool: 'dispatch_task', input: { taskId: b } }], reply: '2' },
      { reply: 'noted' },
      { calls: [{ tool: 'dispatch_task', input: { taskId: c } }], reply: '3' },
    ]);
    const opened = await startAndSettle(h, 'a');
    await h.manager.confirmAction(opened.id, opened.pendingActions[0].id, true);
    expect(h.manager.listGrants(opened.id)).toEqual([]);
    await settled(h, opened.id);

    const second = await nextTurn(h, opened.id, 'b');
    expect(second.pendingActions).toHaveLength(1);
    await h.manager.confirmAction(
      opened.id,
      second.pendingActions[0].id,
      true,
      'human:test',
      false,
      'session'
    );
    await settled(h, opened.id);
    h.manager.revokeGrant(opened.id, 'overseer action dispatch_task');
    const third = await nextTurn(h, opened.id, 'c');
    expect(third.pendingActions).toHaveLength(1);
  });

  it('trusting runs the medium tier at once', async () => {
    setAutonomy('trusting');
    const base = makeHarness();
    const taskId = makeTask(base, 'Go');
    const h = managerOn(base, [
      { calls: [{ tool: 'dispatch_task', input: { taskId } }], reply: 'ok' },
    ]);
    const record = await startAndSettle(h, 'dispatch it');
    expect(record.pendingActions).toEqual([]);
    expect(h.orchestrator.list().map((r) => r.taskId)).toEqual([taskId]);
    expect(record.messages.find((m) => m.role === 'action')).toMatchObject({
      auto: true,
      tier: 'medium',
      taskIds: [taskId],
    });
    expect(base.ledgerStore.list()[0].detail).toContain(
      'overseer.autonomy trusting (medium tier)'
    );
  });

  it('the high tier asks under trusting, and a session answer grants it nothing', async () => {
    setAutonomy('trusting');
    const base = makeHarness();
    const one = await base.orchestrator.dispatch(makeTask(base, 'One'), 'slow');
    const two = await base.orchestrator.dispatch(makeTask(base, 'Two'), 'slow');
    const h = managerOn(base, [
      { calls: [{ tool: 'cancel_run', input: { runId: one.id } }], reply: '1' },
      { reply: 'noted' },
      { calls: [{ tool: 'cancel_run', input: { runId: two.id } }], reply: '2' },
    ]);
    const opened = await startAndSettle(h, 'cancel one');
    const action = opened.pendingActions[0];
    expect(action).toMatchObject({ tier: 'high' });
    expect(action.grantable).toBeUndefined();

    await h.manager.confirmAction(
      opened.id,
      action.id,
      true,
      'human:test',
      false,
      'session'
    );
    expect(h.manager.listGrants(opened.id)).toEqual([]);
    await settled(h, opened.id);
    const next = await nextTurn(h, opened.id, 'cancel two');
    expect(next.pendingActions.map((a) => a.tool)).toEqual(['cancel_run']);
  });

  it('a setting change applies to the very next call', async () => {
    const base = writableHarness();
    const h = managerOn(base, [
      { calls: [{ tool: 'create_task', input: { title: 'One' } }], reply: '1' },
      { calls: [{ tool: 'create_task', input: { title: 'Two' } }], reply: '2' },
    ]);
    const opened = await startAndSettle(h, 'one');
    expect(opened.pendingActions).toEqual([]);
    setAutonomy('cautious');
    const next = await nextTurn(h, opened.id, 'two');
    expect(next.pendingActions.map((a) => a.tool)).toEqual(['create_task']);
  });

  it('a config that breaks mid-turn asks about everything rather than widening', async () => {
    const base = writableHarness();
    // Breaks the config after the turn started, then makes a low-tier call.
    const backend: OverseerBackend = {
      async start(_prompt, toolset) {
        appendFileSync(
          join(repo, '.dispatch', 'config.yml'),
          '\noverseer: nope\n'
        );
        await toolset.call('create_task', { title: 'X' });
        return { reply: 'queued', sessionId: 's-1' };
      },
      sendMessage: () => Promise.resolve({ reply: '' }),
    };
    const manager = new OverseerManager({
      rootDir: repo,
      registry: base.registry,
      events: base.events,
    });
    manager.registerBackend('broken', backend);
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    const started = manager.start('file it', 'broken');
    await waitFor(() => manager.get(started.id).state !== 'running');
    errors.mockRestore();
    expect(manager.get(started.id).pendingActions.map((a) => a.tool)).toEqual([
      'create_task',
    ]);
    expect(base.store.list()).toEqual([]);
  });

  it('tells the model per tool whether a call runs or queues, grants included', async () => {
    const base = makeHarness();
    const taskId = makeTask(base, 'T');
    const h = managerOn(base, [
      { calls: [{ tool: 'dispatch_task', input: { taskId } }], reply: 'q' },
      { reply: 'ok' },
    ]);
    // Records every turn's tool descriptors on the way to the fake.
    const seenTools: OverseerToolset['tools'][] = [];
    const fake = h.backend;
    h.manager.registerBackend('fake', {
      start: (prompt, toolset, options) => {
        seenTools.push(toolset.tools);
        return fake.start(prompt, toolset, options);
      },
      sendMessage: (sessionId, message, toolset, options) => {
        seenTools.push(toolset.tools);
        return fake.sendMessage(sessionId, message, toolset, options);
      },
    });
    const opened = await startAndSettle(h, 'go');
    const routes = (i: number) =>
      Object.fromEntries(
        (seenTools[i] ?? [])
          .filter((t) => t.mutating)
          .map((t) => [t.name, t.route])
      );
    expect(routes(0)).toMatchObject({
      create_task: 'auto',
      dispatch_task: 'ask-once',
      cancel_run: 'ask',
    });
    await h.manager.confirmAction(
      opened.id,
      opened.pendingActions[0].id,
      true,
      'human:test',
      false,
      'session'
    );
    // The turn the approval wakes already sees the grant.
    await settled(h, opened.id);
    expect(routes(1)).toMatchObject({
      dispatch_task: 'auto',
      cancel_run: 'ask',
    });
  });

  it('an auto-run call that fails is reported as failed, not left pending', async () => {
    // No task writer on this harness, so create_task's effect throws.
    const base = makeHarness();
    const h = managerOn(base, [
      {
        calls: [{ tool: 'create_task', input: { title: 'Nope' } }],
        reply: 'x',
      },
    ]);
    const record = await startAndSettle(h, 'file it');
    expect(record.pendingActions).toEqual([]);
    const row = record.messages.find((m) => m.role === 'action');
    expect(row).toMatchObject({ outcome: 'failed', auto: true });
    expect(row?.text).toContain('task writes are not available here');
    expect(h.backend.observations[0].result.isError).toBe(true);
    expect(h.registry.listPending()).toEqual([]);
    expect(base.ledgerStore.list()).toEqual([]);
  });

  it('the actions one turn queues share a batch; the next turn gets its own', async () => {
    const base = makeHarness();
    const a = makeTask(base, 'A');
    const b = makeTask(base, 'B');
    const c = makeTask(base, 'C');
    const h = managerOn(base, [
      {
        calls: [
          { tool: 'dispatch_task', input: { taskId: a } },
          { tool: 'dispatch_task', input: { taskId: b } },
        ],
        reply: 'two queued',
      },
      { calls: [{ tool: 'dispatch_task', input: { taskId: c } }], reply: '1' },
    ]);
    const opened = await startAndSettle(h, 'both');
    const [first, second] = opened.pendingActions;
    expect(first.batch).toBeDefined();
    expect(second.batch).toBe(first.batch);
    const next = await nextTurn(h, opened.id, 'and c');
    const third = next.pendingActions.find(
      (x) => x.id !== first.id && x.id !== second.id
    );
    expect(third?.batch).toBeDefined();
    expect(third?.batch).not.toBe(first.batch);
  });
});

// A backend whose every turn asks the human `questions` through askHuman and
// records how the call ended, the way ClaudeOverseer's AskUserQuestion does.
class AskingBackend implements OverseerBackend {
  readonly answers: OverseerQuestionAnswer[] = [];
  private asked = 0;

  constructor(private readonly questions: OverseerQuestion[]) {}

  start(
    _prompt: string,
    _toolset: OverseerToolset,
    options?: OverseerTurnOptions
  ): Promise<OverseerTurn> {
    return this.turn(options);
  }

  sendMessage(
    _sessionId: string | undefined,
    _message: string,
    _toolset: OverseerToolset,
    options?: OverseerTurnOptions
  ): Promise<OverseerTurn> {
    return this.turn(options);
  }

  private async turn(options?: OverseerTurnOptions): Promise<OverseerTurn> {
    this.asked += 1;
    const answer = (await options?.askHuman?.({
      requestId: `ask-${this.asked}`,
      questions: this.questions,
    })) ?? { answered: false, reason: 'no askHuman' };
    this.answers.push(answer);
    return { reply: 'thanks', sessionId: 'sess' };
  }
}

describe('OverseerManager questions (AskUserQuestion)', () => {
  const which: OverseerQuestion = {
    question: 'Which library should we use?',
    header: 'Library',
    options: [
      { label: 'date-fns', description: 'Small, functional' },
      { label: 'moment', description: 'Time zones built in' },
    ],
    multiSelect: false,
  };

  function makeAsking(questions: OverseerQuestion[]) {
    const h = makeManager({ ok: true, reply: 'unused' });
    const asking = new AskingBackend(questions);
    h.manager.registerBackend('asking', asking);
    return { ...h, asking };
  }

  it('parks the question as a card, never a permission, and hands a typed answer back', async () => {
    const h = makeAsking([which]);
    const started = h.manager.start('pick one', 'asking');
    await waitFor(
      () => (h.manager.get(started.id).pendingQuestions ?? []).length > 0
    );

    const parked = h.manager.get(started.id);
    expect(parked.state).toBe('running');
    expect(parked.pendingApprovals).toEqual([]);
    expect(parked.pendingQuestions).toEqual([
      {
        requestId: 'ask-1',
        questions: [which],
        messageIds: [null],
        answers: {},
        askedAt: expect.any(String),
      },
    ]);
    expect(parked.messages.at(-1)).toMatchObject({
      role: 'question',
      requestId: 'ask-1',
      outcome: 'pending',
      text: 'Which library should we use?',
    });

    // A free-text "Other" answer is just the human's words.
    h.manager.answerQuestion(started.id, 'ask-1', {
      [which.question]: '  neither, use Temporal  ',
    });
    await waitFor(() => h.manager.get(started.id).state === 'ready');
    expect(h.asking.answers).toEqual([
      {
        answered: true,
        answers: { [which.question]: 'neither, use Temporal' },
      },
    ]);
    const settled = h.manager.get(started.id);
    expect(settled.pendingQuestions).toEqual([]);
    expect(
      settled.messages
        .filter((m) => m.role === 'question')
        .map((m) => [m.outcome, m.text])
    ).toEqual([
      ['pending', 'Which library should we use?'],
      ['answered', 'Answered: Library → neither, use Temporal'],
    ]);
  });

  it('keeps an unanswered question open while the turn runs', async () => {
    const h = makeAsking([which]);
    const started = h.manager.start('pick one', 'asking');
    await waitFor(
      () => (h.manager.get(started.id).pendingQuestions ?? []).length > 0
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A blank answer, or one to a question it did not ask, settles nothing.
    h.manager.answerQuestion(started.id, 'ask-1', {
      [which.question]: '   ',
      'Something else?': 'yes',
    });
    const still = h.manager.get(started.id);
    expect(still.state).toBe('running');
    expect(still.pendingQuestions?.[0]?.answers).toEqual({});
    expect(h.asking.answers).toEqual([]);

    expect(() =>
      h.manager.answerQuestion(started.id, 'ask-9', { [which.question]: 'x' })
    ).toThrow(OrchestratorNotFoundError);

    h.manager.stop(started.id);
    await waitFor(() => h.manager.get(started.id).state !== 'running');
    expect(h.asking.answers).toEqual([
      { answered: false, reason: 'the turn ended before the human answered' },
    ]);
    expect(h.manager.get(started.id).messages.at(-2)).toMatchObject({
      role: 'question',
      outcome: 'denied',
    });
  });
});
