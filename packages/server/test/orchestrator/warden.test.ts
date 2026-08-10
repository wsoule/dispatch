import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import type { ServerEvent } from '../../src/events.js';
import { LedgerStore } from '../../src/ledger.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { MergeQueue } from '../../src/orchestrator/mergeQueue.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import type { CommandResult } from '../../src/orchestrator/pr.js';
import { QuestionRegistry } from '../../src/orchestrator/questions.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from '../../src/orchestrator/types.js';
import { WardenManager } from '../../src/orchestrator/warden.js';
import type { WardenRecord } from '../../src/orchestrator/warden.js';
import type {
  WardenBackend,
  WardenToolset,
  WardenTurn,
} from '../../src/orchestrator/wardenBackend.js';
import { FakeWarden } from '../../src/orchestrator/wardens/fake.js';
import type { FakeWardenScript } from '../../src/orchestrator/wardens/fake.js';
import type { WardenToolContext } from '../../src/orchestrator/wardenTools.js';
import { WardenToolRegistry } from '../../src/orchestrator/wardenTools.js';
import { initGitRepo } from './helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

// Same teardown contract as wardenTools.test.ts: a merge queue left running
// arms a retry timer, and a 'slow' run left live finishes during some LATER
// test against whatever DISPATCH_HOME is set then.
const liveQueues: MergeQueue[] = [];
const liveOrchestrators: Orchestrator[] = [];

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-warden-mgr-');
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
// depends on a real rebase/push (copied in shape from wardenTools.test.ts).
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
  events: EventBus;
  seen: ServerEvent[];
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
  const ctx: WardenToolContext = {
    store,
    cache,
    orchestrator,
    mergeQueue,
    questions: new QuestionRegistry(),
    ledgerStore: new LedgerStore(repo),
    defaultExecutor: 'fake',
  };
  return { ...ctx, registry: new WardenToolRegistry(ctx), events, seen };
}

interface ManagerHarness extends Harness {
  manager: WardenManager;
  backend: FakeWarden;
}

function makeManager(script: FakeWardenScript): ManagerHarness {
  const h = makeHarness();
  const backend = new FakeWarden(script);
  const manager = new WardenManager({
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
): Promise<WardenRecord> {
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

describe('WardenManager turns', () => {
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
    expect(h.seen.some((e) => e.type === 'warden.changed')).toBe(true);
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
    // The model saw the real payload, not a summary of it.
    expect(h.backend.observations[0].result.isError).toBe(false);
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
      'unknown warden tool: summon_the_moon'
    );
    // A call that failed its schema is not a queued action.
    expect(record.pendingActions).toEqual([]);
    expect(record.messages.filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  it('lands at failed with the backend error when a turn throws', async () => {
    const h = makeManager({ ok: false, error: 'model unreachable' });

    const record = await startAndSettle(h);

    expect(record.state).toBe('failed');
    expect(record.error).toBe('model unreachable');
  });

  it('rejects a follow-up while a turn is still in flight', async () => {
    const h = makeManager({ ok: true, reply: 'unused' });
    // A backend that never settles, so the conversation stays `running`.
    let release: (() => void) | undefined;
    const stuck: WardenBackend = {
      start: () =>
        new Promise<WardenTurn>((resolve) => {
          release = () => resolve({ reply: 'done' });
        }),
      sendMessage: async () => ({ reply: 'done' }),
    };
    h.manager.registerBackend('stuck', stuck);

    const started = h.manager.start('hello', 'stuck');
    expect(() => h.manager.sendMessage(started.id, 'and also')).toThrow(
      OrchestratorConflictError
    );

    release?.();
    await waitFor(() => h.manager.get(started.id).state === 'ready');
    // Idle again — the same follow-up is now accepted.
    expect(h.manager.sendMessage(started.id, 'and also').state).toBe('running');
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
    let offered: WardenToolset | undefined;
    h.manager.registerBackend('spy', {
      start: async (_prompt, toolset) => {
        offered = toolset;
        return { reply: 'ok' };
      },
      sendMessage: async () => ({ reply: 'ok' }),
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
      'deny_run',
      'dequeue_merge',
      'dispatch_task',
      'message_run',
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
  record: WardenRecord;
  taskId: string;
  actionId: string;
}> {
  const base = makeHarness();
  const taskId = makeTask(base, title);
  const backend = new FakeWarden({
    ok: true,
    turns: [
      {
        calls: [{ tool: 'dispatch_task', input: { taskId } }],
        reply: 'queued it for you',
      },
      { reply: 'anything else?' },
    ],
  });
  const manager = new WardenManager({
    rootDir: repo,
    registry: base.registry,
    events: base.events,
  });
  manager.registerBackend('fake', backend);
  const h: ManagerHarness = { ...base, manager, backend };
  const record = await startAndSettle(h, 'dispatch it');
  return { h, record, taskId, actionId: record.pendingActions[0].id };
}

describe('WardenManager queued actions', () => {
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

  it('keeps an action pending and records the failure when applying throws', async () => {
    const h = makeManager({ ok: true, reply: 'placeholder' });
    // A run that stays live long enough to queue a cancel against it...
    const taskId = makeTask(h, 'Long one');
    const meta = await h.orchestrator.dispatch(taskId, 'slow');
    h.manager.registerBackend(
      'fake',
      new FakeWarden({
        ok: true,
        calls: [{ tool: 'cancel_run', input: { runId: meta.id } }],
        reply: 'queued a cancel',
      })
    );
    const opened = await startAndSettle(h, 'cancel it');
    const actionId = opened.pendingActions[0].id;
    // ...and is then cancelled out from under the queued action, so applying
    // it hits the orchestrator's own "already finished" conflict.
    await h.orchestrator.cancel(meta.id);

    await expect(
      h.manager.confirmAction(opened.id, actionId, true)
    ).rejects.toThrow();

    const record = h.manager.get(opened.id);
    expect(record.pendingActions.map((a) => a.id)).toEqual([actionId]);
    expect(record.messages.at(-1)).toMatchObject({
      role: 'action',
      actionId,
      outcome: 'failed',
    });
    expect(h.registry.getAction(actionId)?.status).toBe('pending');
  });

  it('tells the model on the next turn what the human decided', async () => {
    const { h, record: opened, actionId } = await queueDispatch();
    await h.manager.confirmAction(opened.id, actionId, false);

    h.manager.sendMessage(opened.id, 'so did it go?');
    await waitFor(() => h.manager.get(opened.id).state === 'ready');

    // The model's own tool result only ever said "queued", so this preamble is
    // the only way it learns the human refused.
    const followUp = h.backend.prompts[1];
    expect(followUp).toContain('REFUSED');
    expect(followUp).toContain('Dispatch');
    expect(followUp).toEndWith('so did it go?');
    // Delivered once, not on every later turn.
    expect(h.manager.get(opened.id).undeliveredDecisions).toEqual([]);
    // The transcript keeps what the human actually typed.
    expect(h.manager.get(opened.id).messages.at(-2)).toMatchObject({
      role: 'user',
      text: 'so did it go?',
    });
  });

  it('keeps the decision for the next attempt when the turn carrying it fails', async () => {
    const { h, record: opened, actionId } = await queueDispatch();
    await h.manager.confirmAction(opened.id, actionId, true);

    // The turn that would have delivered the news dies before reaching a model.
    h.manager.registerBackend(
      'fake',
      new FakeWarden({ ok: false, error: 'model unreachable' })
    );
    h.manager.sendMessage(opened.id, 'did it go?');
    await waitFor(() => h.manager.get(opened.id).state === 'failed');
    expect(h.manager.get(opened.id).undeliveredDecisions).toHaveLength(1);

    // So the retry still carries it.
    const retry = new FakeWarden({ ok: true, reply: 'yes, it is running' });
    h.manager.registerBackend('fake', retry);
    h.manager.sendMessage(opened.id, 'did it go?');
    await waitFor(() => h.manager.get(opened.id).state === 'ready');
    expect(retry.prompts[0]).toContain('approved');
    expect(h.manager.get(opened.id).undeliveredDecisions).toEqual([]);
  });
});
