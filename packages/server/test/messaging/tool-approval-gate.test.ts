import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import type { Message } from '@dispatch-foo/protocol';
import {
  gateOf,
  openMessagesDb,
  SqliteMessageStore,
} from '@dispatch-foo/protocol';
import { describe, expect, it, spyOn } from 'bun:test';
import { join } from 'node:path';

import { closeOrphanedGates } from '../../src/messaging/gates.js';
import type { Messaging } from '../../src/messaging/service.js';
import {
  previewToolInput,
  TOOL_INPUT_PREVIEW_BYTES,
} from '../../src/messaging/toolApproval.js';
import { ClaudeExecutor } from '../../src/orchestrator/executors/claude.js';
import {
  HUMAN,
  makeOrchestrator,
  openRecovered,
  ParkingExecutor,
  useTempProject,
  waitFor,
} from './harness.js';

const project = useTempProject();

// A live run on the parking executor, not yet parked.
async function liveParkingRun() {
  const { orchestrator, store } = makeOrchestrator(project.root());
  const executor = new ParkingExecutor();
  orchestrator.registerExecutor('parking', executor);
  const messaging = await openRecovered(project.root(), orchestrator, store);
  const task = store.create({ title: 'Needs a shell' });
  const meta = await orchestrator.dispatch(task.meta.id, 'parking', {});
  return { orchestrator, executor, messaging, meta, task };
}

// A teammate's parked run: `ana` operates it, deciding when `anaDecides`.
async function teammateParkedRun(anaDecides: boolean) {
  const { orchestrator, store } = makeOrchestrator(project.root());
  const executor = new ParkingExecutor();
  orchestrator.registerExecutor('parking', executor);
  const messaging = await openRecovered(
    project.root(),
    orchestrator,
    store,
    undefined,
    {
      deciders: {
        canDecide: (ref) =>
          ref === 'human:wyat' || (anaDecides && ref === 'human:ana'),
        hasAccess: () => true,
      },
    }
  );
  const task = store.create({ title: 'Needs a shell' });
  const meta = await orchestrator.dispatch(task.meta.id, 'parking', {
    operator: 'human:ana',
  });
  executor.park('req-1', 'Bash', { command: 'pnpm install' });
  await waitFor(() => messaging.engine.openBlocking().length === 1);
  const [gate] = messaging.engine.openBlocking();
  return { orchestrator, messaging, meta, gate };
}

async function parkedRun(input: unknown = { command: 'pnpm install' }) {
  const live = await liveParkingRun();
  live.executor.park('req-1', 'Bash', input);
  await waitFor(() => live.messaging.engine.openBlocking().length === 1);
  const [gate] = live.messaging.engine.openBlocking();
  return { ...live, gate };
}

// The open tool-approval gate for one parked call, by its requestId.
function gateFor(messaging: Messaging, requestId: string): Message {
  const gate = messaging.engine
    .openBlocking()
    .find((m) => gateRequestId(m) === requestId);
  if (gate === undefined) throw new Error(`no open gate for ${requestId}`);
  return gate;
}

function gateRequestId(message: Message): string | undefined {
  const gate = gateOf(message);
  return gate?.type === 'tool-approval' ? gate.requestId : undefined;
}

function openRequestIds(messaging: Messaging): (string | undefined)[] {
  return messaging.engine
    .openBlocking()
    .map(gateRequestId)
    .sort((a, b) => (a ?? '').localeCompare(b ?? ''));
}

describe("tool-approval gates for a teammate's run (XH-R9)", () => {
  it('go to an operator who can decide', async () => {
    const { orchestrator, messaging, meta, gate } =
      await teammateParkedRun(true);
    expect(gate.to).toEqual(['human:ana']);
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('go to the owner when the operator cannot decide, and tell the operator', async () => {
    const { orchestrator, messaging, meta, gate } =
      await teammateParkedRun(false);
    expect(gate.to).toEqual(['human:wyat']);
    await waitFor(
      () => messaging.store.deliveries({ recipient: 'human:ana' }).length > 0
    );
    const [notice] = messaging.store
      .deliveries({ recipient: 'human:ana' })
      .map((d) => messaging.store.getMessage(d.messageId));
    expect(notice).toMatchObject({
      from: 'agent:dispatch',
      kind: 'notice',
      refs: [
        { type: 'run', id: meta.id },
        { type: 'task', id: meta.taskId },
      ],
    });
    expect(notice?.body).toContain('human:wyat');
    await orchestrator.cancel(meta.id);
    messaging.close();
  });
});

describe('tool-approval gates', () => {
  it('a parked tool call raises one gate to the owner and parks the run', async () => {
    const { orchestrator, messaging, meta, task, gate } = await parkedRun();
    expect(gate).toMatchObject({
      from: 'agent:dispatch',
      to: ['human:wyat'],
      kind: 'question',
      blocking: true,
      choices: ['approve', 'approve-session', 'deny'],
      refs: [
        { type: 'run', id: meta.id },
        { type: 'task', id: task.meta.id },
      ],
    });
    expect(gate.data).toEqual({
      type: 'tool-approval',
      requestId: 'req-1',
      runId: meta.id,
      tool: 'Bash',
      input: { command: 'pnpm install' },
      floor: false,
    });
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('awaiting-approval');
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('approve-session resumes the run with a session-wide allow', async () => {
    const { orchestrator, executor, messaging, meta, gate } = await parkedRun();
    await messaging.engine.reply(
      gate.id,
      { body: '', choice: 'approve-session' },
      HUMAN
    );
    expect(executor.decisions).toEqual([
      { requestId: 'req-1', decision: { allow: true, scope: 'session' } },
    ]);
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('running');
    expect(messaging.engine.openBlocking()).toEqual([]);
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('deny carries the answer body to the agent as the reason', async () => {
    const { orchestrator, executor, messaging, meta, gate } = await parkedRun();
    await messaging.engine.reply(
      gate.id,
      { body: 'not on main', choice: 'deny' },
      HUMAN
    );
    expect(executor.decisions[0]?.decision).toEqual({
      allow: false,
      reason: 'not on main',
    });
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('a run cannot answer its own approval', async () => {
    const { orchestrator, messaging, meta, gate } = await parkedRun();
    await expect(
      messaging.engine.reply(
        gate.id,
        { body: '', choice: 'approve' },
        {
          address: `run:${meta.id}`,
          canDecide: false,
        }
      )
    ).rejects.toMatchObject({ code: 'not-found', field: 'replyTo' });
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('closes the gate when the run ends, and a late answer is a conflict', async () => {
    const { orchestrator, executor, messaging, meta, gate } = await parkedRun();
    await orchestrator.cancel(meta.id);
    expect(messaging.engine.answerOf(gate.id)?.data).toEqual({
      type: 'x-closed',
      reason: 'the run ended',
    });
    expect(messaging.engine.openBlocking()).toEqual([]);
    await expect(
      messaging.engine.reply(gate.id, { body: '', choice: 'approve' }, HUMAN)
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(executor.decisions).toEqual([]);
    messaging.close();
  });

  it('stopping a parked run closes its gate and returns it to running', async () => {
    const { orchestrator, messaging, meta, gate } = await parkedRun();
    orchestrator.requestStop(meta.id);
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('running');
    expect(orchestrator.pendingApprovalsFor(meta.id)).toEqual([]);
    expect(messaging.engine.answerOf(gate.id)?.body).toBe(
      'Closed: the run is stopping'
    );
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('a run that winds down while parked closes its gate and returns it to running', async () => {
    const { orchestrator, executor, messaging, meta, gate } = await parkedRun();
    executor.windDown();
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('running');
    expect(orchestrator.pendingApprovalsFor(meta.id)).toEqual([]);
    expect(messaging.engine.answerOf(gate.id)?.data).toEqual({
      type: 'x-closed',
      reason: 'the run ended',
    });
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('two calls parked at once each get a gate, and the run stays parked until both are answered', async () => {
    const { orchestrator, executor, messaging, meta } = await liveParkingRun();
    executor.park('req-1', 'Bash', { command: 'ls' });
    executor.park('req-2', 'Bash', { command: 'pwd' });
    await waitFor(() => messaging.engine.openBlocking().length === 2);
    expect(openRequestIds(messaging)).toEqual(['req-1', 'req-2']);

    await messaging.engine.reply(
      gateFor(messaging, 'req-1').id,
      { body: '', choice: 'approve' },
      HUMAN
    );
    expect(executor.decisions.map((d) => d.requestId)).toEqual(['req-1']);
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('awaiting-approval');
    expect(openRequestIds(messaging)).toEqual(['req-2']);

    await messaging.engine.reply(
      gateFor(messaging, 'req-2').id,
      { body: '', choice: 'approve' },
      HUMAN
    );
    expect(executor.decisions.map((d) => d.requestId)).toEqual([
      'req-1',
      'req-2',
    ]);
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('running');
    expect(messaging.engine.openBlocking()).toEqual([]);
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('a call parked after an earlier gate was written can be answered first', async () => {
    const { orchestrator, executor, messaging, meta } = await parkedRun();
    executor.park('req-2', 'Bash', { command: 'pwd' });
    await waitFor(() => messaging.engine.openBlocking().length === 2);

    orchestrator.approve(meta.id, 'req-2', { allow: false });
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('awaiting-approval');
    expect(orchestrator.pendingApprovalFor(meta.id, 'req-1')).toMatchObject({
      requestId: 'req-1',
    });
    expect(orchestrator.pendingApprovalFor(meta.id, 'req-2')).toBeUndefined();
    expect(openRequestIds(messaging)).toEqual(['req-1']);

    await messaging.engine.reply(
      gateFor(messaging, 'req-1').id,
      { body: '', choice: 'approve' },
      HUMAN
    );
    expect(executor.decisions.map((d) => d.requestId)).toEqual([
      'req-2',
      'req-1',
    ]);
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('running');
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('stopping a run with two parked calls closes both gates', async () => {
    const { orchestrator, executor, messaging, meta } = await parkedRun();
    executor.park('req-2', 'Bash', { command: 'pwd' });
    await waitFor(() => messaging.engine.openBlocking().length === 2);
    const gates = messaging.engine.openBlocking();

    orchestrator.requestStop(meta.id);
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('running');
    expect(orchestrator.pendingApprovalsFor(meta.id)).toEqual([]);
    for (const gate of gates) {
      expect(messaging.engine.answerOf(gate.id)?.body).toBe(
        'Closed: the run is stopping'
      );
    }
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('a run that winds down with two parked calls closes both gates', async () => {
    const { orchestrator, executor, messaging, meta } = await parkedRun();
    executor.park('req-2', 'Bash', { command: 'pwd' });
    await waitFor(() => messaging.engine.openBlocking().length === 2);

    executor.windDown();
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('running');
    expect(messaging.engine.openBlocking()).toEqual([]);
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('answering after the run moved on is swallowed, marked applied, and the answerer is told', async () => {
    const { orchestrator, messaging, meta, gate } = await parkedRun();
    // Simulates a replay after the run already left awaiting-approval.
    orchestrator.approve(meta.id, 'req-1', { allow: true });
    const answer: Message = {
      ...gate,
      id: 'm-late',
      replyTo: gate.id,
      kind: 'answer',
      from: 'human:wyat',
      to: ['agent:dispatch'],
      blocking: false,
      choice: 'approve',
    };
    await expect(messaging.gates.handle(gate, answer)).resolves.toBeUndefined();
    const notices = messaging.engine
      .inbox('human:wyat')
      .filter((i) => i.message.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message.body).toStartWith(
      `Not applied: run ${meta.id} was no longer waiting on this approval`
    );
    expect(notices[0]?.message.refs).toEqual([
      { type: 'message', id: gate.id },
    ]);
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('an approval settled before its gate is written still closes the gate', async () => {
    const { orchestrator, executor, messaging, meta } = await liveParkingRun();
    const raised: Message[] = [];
    messaging.engine.subscribe((e) => {
      if (e.type === 'message' && gateOf(e.message)?.type === 'tool-approval')
        raised.push(e.message);
    });
    executor.park('req-1', 'Bash', { command: 'ls' });
    // raise() is still awaiting engine.send, so settle() finds no gate yet.
    orchestrator.approve(meta.id, 'req-1', { allow: true });
    await waitFor(
      () =>
        raised.length === 1 && messaging.engine.answerOf(raised[0].id) !== null
    );
    expect(messaging.engine.answerOf(raised[0].id)?.data).toMatchObject({
      type: 'x-closed',
    });
    expect(messaging.engine.openBlocking()).toEqual([]);
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('a call that parks after messaging closed is denied, not left without a gate', async () => {
    const { orchestrator, executor, messaging, meta } = await liveParkingRun();
    messaging.close();
    executor.park('req-2', 'Bash', { command: 'ls' });
    await waitFor(() => executor.decisions.length === 1);
    expect(executor.decisions[0]).toEqual({
      requestId: 'req-2',
      decision: {
        allow: false,
        reason: 'Dispatch could not ask a human: messaging is closed',
      },
    });
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('running');
    await orchestrator.cancel(meta.id);
  });

  it('a call whose gate cannot be written is denied with the reason', async () => {
    const { orchestrator, executor, messaging, meta } = await liveParkingRun();
    const send = spyOn(messaging.engine, 'send').mockImplementation(() =>
      Promise.reject(new Error('disk full'))
    );
    executor.park('req-1', 'Bash', { command: 'ls' });
    await waitFor(() => executor.decisions.length === 1);
    send.mockRestore();
    expect(executor.decisions[0]).toEqual({
      requestId: 'req-1',
      decision: {
        allow: false,
        reason: 'Dispatch could not ask a human: disk full',
      },
    });
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('running');
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('an input over 8 KiB is previewed and marked truncated', async () => {
    const { orchestrator, messaging, meta, gate } = await parkedRun({
      command: 'x'.repeat(20_000),
    });
    const data = gate.data as { input: unknown; truncated?: boolean };
    expect(data.truncated).toBe(true);
    expect(typeof data.input).toBe('string');
    expect(Buffer.byteLength(data.input as string)).toBeLessThanOrEqual(
      TOOL_INPUT_PREVIEW_BYTES
    );
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('flags a floor call on its full input and names it in the body, though the preview was cut', async () => {
    const command = `${' '.repeat(9000)}; git push --force origin main`;
    const { orchestrator, messaging, meta, gate } = await parkedRun({
      command,
    });
    expect(gate.data).toMatchObject({ truncated: true, floor: true });
    expect(gate.body).toBe(
      'Needs a shell wants to run Bash: ; git push --force origin main'
    );
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('the boot sweep closes gates whose run did not survive', async () => {
    const dbPath = join(project.root(), 'messages.db');
    const seedDb = openMessagesDb(dbPath);
    const seed = new SqliteMessageStore(seedDb);
    seed.insertMessage({
      id: 'm-orphan00000000000000000001',
      thread: 'm-orphan00000000000000000001',
      replyTo: null,
      from: 'agent:dispatch',
      to: ['human:wyat'],
      kind: 'question',
      body: 'x wants to run Bash',
      refs: [],
      urgent: false,
      blocking: true,
      choices: ['approve', 'approve-session', 'deny'],
      wake: 'none',
      createdAt: '2026-09-25T10:00:00.000Z',
      data: {
        type: 'tool-approval',
        requestId: 'req-9',
        runId: 'r-00dead',
        tool: 'Bash',
        input: {},
      },
    });
    seedDb.close();
    const { orchestrator, store } = makeOrchestrator(project.root());
    const messaging = await openRecovered(project.root(), orchestrator, store);
    expect(closeOrphanedGates(messaging.engine, orchestrator)).toBe(1);
    expect(
      messaging.engine.answerOf('m-orphan00000000000000000001')?.body
    ).toBe('Closed: the daemon restarted');
    messaging.close();
  });
});

// A Claude executor over an SDK query that stays open until the run is
// interrupted; `options()` is what the executor handed query().
function hangingClaudeExecutor(): {
  executor: ClaudeExecutor;
  options(): Options;
} {
  let options: Options | undefined;
  const executor = new ClaudeExecutor(((args: { options?: Options }) => {
    options = args.options;
    let end = () => {};
    const ended = new Promise<void>((resolve) => {
      end = resolve;
    });
    const messages = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<never>> {
        await ended;
        return { done: true, value: undefined };
      },
    };
    return Object.assign(messages, {
      interrupt: () => {
        end();
        return Promise.resolve();
      },
      close: () => end(),
    }) as unknown as Query;
  }) as never);
  return {
    executor,
    options() {
      if (options === undefined) throw new Error('query() was never called');
      return options;
    },
  };
}

describe('tool-approval gates on a Claude run', () => {
  it('parks two concurrent calls on their own gates and answers each exactly', async () => {
    const { orchestrator, store } = makeOrchestrator(project.root());
    const claude = hangingClaudeExecutor();
    orchestrator.registerExecutor('claude', claude.executor);
    const messaging = await openRecovered(project.root(), orchestrator, store);
    const task = store.create({ title: 'Two at once' });
    const meta = await orchestrator.dispatch(task.meta.id, 'claude', {});
    const canUseTool = claude.options().canUseTool;
    if (canUseTool === undefined) throw new Error('no canUseTool');
    const ask = (requestId: string, command: string) =>
      canUseTool(
        'Bash',
        { command },
        {
          signal: new AbortController().signal,
          toolUseID: `tu-${requestId}`,
          requestId,
        }
      );

    const first = ask('cli-1', 'ls');
    const second = ask('cli-2', 'pwd');
    await waitFor(() => messaging.engine.openBlocking().length === 2);
    await messaging.engine.reply(
      gateFor(messaging, 'cli-2').id,
      { body: 'not that one', choice: 'deny' },
      HUMAN
    );
    expect(await second).toEqual({
      behavior: 'deny',
      message: 'not that one',
    });
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('awaiting-approval');

    await messaging.engine.reply(
      gateFor(messaging, 'cli-1').id,
      { body: '', choice: 'approve' },
      HUMAN
    );
    expect(await first).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
    });
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('running');
    expect(messaging.engine.openBlocking()).toEqual([]);
    await orchestrator.cancel(meta.id);
    messaging.close();
  });
});

describe('previewToolInput', () => {
  it('passes an input that fits through untouched', () => {
    expect(previewToolInput({ command: 'ls' })).toEqual({
      input: { command: 'ls' },
    });
  });

  it('cuts oversized JSON on a code point and marks it', () => {
    const { input, truncated } = previewToolInput({ text: '😀'.repeat(5000) });
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(input as string)).toBeLessThanOrEqual(
      TOOL_INPUT_PREVIEW_BYTES
    );
    expect(input as string).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('never throws on input JSON cannot encode', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(previewToolInput(circular)).toEqual({ input: '[object Object]' });
    expect(previewToolInput(10n)).toEqual({ input: '10' });
  });
});
