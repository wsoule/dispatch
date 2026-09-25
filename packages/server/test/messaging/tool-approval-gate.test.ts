import type { Message } from '@dispatch/protocol';
import { gateOf, openMessagesDb, SqliteMessageStore } from '@dispatch/protocol';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import { closeOrphanedGates } from '../../src/messaging/gates.js';
import {
  previewToolInput,
  TOOL_INPUT_PREVIEW_BYTES,
} from '../../src/messaging/toolApproval.js';
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

async function parkedRun(input: unknown = { command: 'pnpm install' }) {
  const live = await liveParkingRun();
  live.executor.park('req-1', 'Bash', input);
  await waitFor(() => live.messaging.engine.openBlocking().length === 1);
  const [gate] = live.messaging.engine.openBlocking();
  return { ...live, gate };
}

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
    ).rejects.toMatchObject({ code: 'forbidden' });
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
    expect(orchestrator.pendingApprovalFor(meta.id)).toBeUndefined();
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
    expect(orchestrator.pendingApprovalFor(meta.id)).toBeUndefined();
    expect(messaging.engine.answerOf(gate.id)?.data).toEqual({
      type: 'x-closed',
      reason: 'the run ended',
    });
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
