import type { SqliteDatabase } from '@dispatch/core';
import { queryAll } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  GATE_RAISERS,
  gateTypeOf,
  hasGateData,
  SYSTEM_ADDRESS,
} from '../src/constants.js';
import { DeliveryEngine } from '../src/engine.js';
import { GATE_TYPES, validateSendInput } from '../src/envelope.js';
import type { Message } from '../src/envelope.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';
import { FakeHost } from './fakeHost.js';

const system = { address: SYSTEM_ADDRESS, canDecide: true };
const human = { address: 'human:wyat', canDecide: true };
const run1 = { address: 'run:r-000001', canDecide: false };
const agent = { address: 'agent:wyat/claude', canDecide: false };
const T0 = '2026-09-23T09:00:00.000Z';
const TOOL = {
  type: 'tool-approval',
  requestId: 'req-1',
  runId: 'r-000001',
  tool: 'Bash',
  input: {},
  floor: false,
};

let db: SqliteDatabase;
let store: SqliteMessageStore;
let host: FakeHost;
let engine: DeliveryEngine;

beforeEach(() => {
  db = openMessagesDb(':memory:');
  store = new SqliteMessageStore(db);
  host = new FakeHost();
  host.startRun('t-000001', 'r-000001');
  store.putAgent({
    address: agent.address,
    displayName: 'claude',
    client: 'test',
    tokenHash: 'h',
    status: 'approved',
    muted: false,
    approvedBy: 'human:wyat',
    createdAt: T0,
  });
  engine = new DeliveryEngine({ store, host, gateTypes: GATE_TYPES });
});
afterEach(() => db.close());

// A stored row as an older build could have written it.
function seed(
  m: Partial<Message> & { id: string },
  recipient: string,
  state: 'held' | 'notified' | 'answered' = 'notified'
): Message {
  const message: Message = {
    thread: m.id,
    replyTo: null,
    from: SYSTEM_ADDRESS,
    to: [recipient],
    kind: 'question',
    body: 'decide',
    refs: [],
    urgent: false,
    blocking: true,
    wake: 'none',
    createdAt: T0,
    ...m,
  };
  store.insertMessage(message);
  store.insertDelivery({
    id: `d-${m.id}`,
    messageId: m.id,
    recipient,
    runId: null,
    via: 'direct',
    state,
    updatedAt: T0,
  });
  return message;
}
const applied = (): string[] =>
  queryAll<{ question_id: string }>(
    db,
    'SELECT question_id FROM gate_effects'
  ).map((r) => r.question_id);

describe('gate data (C1)', () => {
  it('defines gate data as an unprefixed data.type on any kind', () => {
    expect(hasGateData({ data: { type: 'wake' } })).toBe(true);
    expect(hasGateData({ data: { type: 'x-closed' } })).toBe(false);
    expect(hasGateData({ data: { blob: 1 } })).toBe(false);
    expect(
      gateTypeOf(
        { kind: 'notice', from: SYSTEM_ADDRESS, data: { type: 'wake' } },
        new Set(['wake'])
      )
    ).toBeNull();
    expect(
      gateTypeOf(
        { kind: 'question', from: 'agent:x', data: { type: 'future' } },
        new Set(['wake'])
      )
    ).toBeNull();
    expect(
      gateTypeOf(
        { kind: 'question', from: 'human:ada', data: { type: 'future' } },
        new Set(['wake'])
      )
    ).toBe('future');
  });

  it('refuses an unregistered unprefixed data.type', async () => {
    await expect(
      engine.send(
        {
          to: ['human:wyat'],
          kind: 'question',
          body: 'x?',
          data: { type: 'poll' },
        },
        run1
      )
    ).rejects.toMatchObject({ code: 'invalid', field: 'data.type' });
  });

  it('refuses gate data on a notice and accepts x- data anywhere', async () => {
    await expect(
      engine.send(
        {
          to: ['human:wyat'],
          kind: 'notice',
          body: 'n',
          data: { type: 'wake', target: 'task:t-000002', message: 'm-x' },
        },
        system
      )
    ).rejects.toMatchObject({ code: 'invalid', field: 'data.type' });
    await engine.send(
      {
        to: ['human:wyat'],
        kind: 'notice',
        body: 'n',
        data: { type: 'x-policy', rung: 2 },
      },
      system
    );
  });

  it("refuses a type outside the engine's gateTypes; the default engine knows only wake", async () => {
    const wakeOnly = new DeliveryEngine({ store, host });
    await expect(
      wakeOnly.send(
        {
          to: ['human:wyat'],
          kind: 'question',
          blocking: true,
          choices: ['approve', 'deny'],
          body: 'run?',
          data: TOOL,
        },
        system
      )
    ).rejects.toMatchObject({ code: 'invalid', field: 'data.type' });
  });

  it('makes a stored gate of an unknown type decide-only when the system or a human raised it', async () => {
    seed(
      {
        id: 'm-unknown',
        choices: ['approve', 'deny'],
        data: { type: 'future-gate', ref: 'x' },
      },
      agent.address
    );
    await expect(
      engine.reply('m-unknown', { body: '', choice: 'approve' }, agent)
    ).rejects.toMatchObject({ code: 'forbidden', field: 'replyTo' });
    await engine.reply('m-unknown', { body: '', choice: 'approve' }, human);
    expect(host.hooks('onAnswered')).toEqual([]);
    expect(applied()).toEqual([]);
  });

  it("keeps an agent's free-form question a plain question", async () => {
    seed(
      { id: 'm-free', from: agent.address, data: { type: 'poll', n: 1 } },
      'run:r-000001',
      'held'
    );
    const { message } = await engine.reply('m-free', { body: 'yes' }, run1);
    expect(message.kind).toBe('answer');
  });

  it('lets a choiceless gate take a choiceless answer', async () => {
    const { message: gate } = await engine.send(
      {
        to: ['human:wyat'],
        kind: 'question',
        blocking: true,
        body: 'wake?',
        data: { type: 'wake', target: 'task:t-000002', message: 'm-x' },
      },
      system
    );
    const { message: a } = await engine.reply(
      gate.id,
      { body: 'go ahead' },
      human
    );
    expect(a.choice).toBeUndefined();
    expect(host.hooks('onAnswered')).toEqual([[gate.id, null]]);
  });
});

describe('ignored answers (C2)', () => {
  it('voids a seeded agent answer on recover, reopens the gate and tells the owner once', async () => {
    seed(
      { id: 'm-gate', choices: ['approve', 'deny'], data: TOOL },
      'human:wyat',
      'answered'
    );
    store.insertMessage({
      id: 'm-bad',
      thread: 'm-gate',
      replyTo: 'm-gate',
      from: agent.address,
      to: [SYSTEM_ADDRESS],
      kind: 'answer',
      body: '',
      choice: 'approve',
      refs: [],
      urgent: false,
      blocking: false,
      wake: 'none',
      createdAt: T0,
    });

    expect(await engine.recover()).toMatchObject({ replayed: 0, voided: 1 });
    expect(host.hooks('onAnswered')).toEqual([]);
    expect(store.getMessage('m-bad')?.kind).toBe('message');
    expect(store.getDelivery('d-m-gate')?.state).toBe('notified');
    expect(engine.openBlocking().map((m) => m.id)).toContain('m-gate');
    const notices = () =>
      store
        .thread('m-gate')
        .filter((m) => m.kind === 'notice' && m.from === SYSTEM_ADDRESS);
    expect(notices().map((n) => n.to)).toEqual([['human:wyat']]);

    await engine.recover();
    expect(notices()).toHaveLength(1);

    await engine.reply('m-gate', { body: '', choice: 'approve' }, human);
    expect(host.hooks('onAnswered')).toEqual([['m-gate', 'approve']]);
    expect(applied()).toEqual(['m-gate']);
  });

  it('still replays a human answer an older build stored', async () => {
    seed(
      { id: 'm-gate', choices: ['approve', 'deny'], data: TOOL },
      'human:wyat',
      'answered'
    );
    store.insertMessage({
      id: 'm-ok',
      thread: 'm-gate',
      replyTo: 'm-gate',
      from: 'human:wyat',
      to: [SYSTEM_ADDRESS],
      kind: 'answer',
      body: '',
      choice: 'deny',
      refs: [],
      urgent: false,
      blocking: false,
      wake: 'none',
      createdAt: T0,
    });
    expect(await engine.recover()).toMatchObject({ replayed: 1, voided: 0 });
  });

  it('leaves an answered gate of a type this engine does not know unapplied, for a build that does', async () => {
    const wakeOnly = new DeliveryEngine({ store, host });
    seed(
      { id: 'm-gate', choices: ['approve', 'deny'], data: TOOL },
      'human:wyat',
      'answered'
    );
    store.insertMessage({
      id: 'm-ok',
      thread: 'm-gate',
      replyTo: 'm-gate',
      from: 'human:wyat',
      to: [SYSTEM_ADDRESS],
      kind: 'answer',
      body: '',
      choice: 'approve',
      refs: [],
      urgent: false,
      blocking: false,
      wake: 'none',
      createdAt: T0,
    });
    expect(await wakeOnly.recover()).toMatchObject({ replayed: 0, voided: 0 });
    expect(await engine.recover()).toMatchObject({ replayed: 1 });
  });
});

describe('deciding principals and raise authority (C5)', () => {
  it('refuses a run or an agent that claims canDecide', async () => {
    await expect(
      engine.send(
        { to: ['human:wyat'], kind: 'message', body: 'hi' },
        { address: 'run:r-000001', canDecide: true }
      )
    ).rejects.toMatchObject({ code: 'forbidden', field: 'from' });
    await expect(
      engine.send(
        { to: ['human:wyat'], kind: 'message', body: 'hi' },
        { address: agent.address, canDecide: true }
      )
    ).rejects.toMatchObject({ code: 'forbidden', field: 'from' });
  });

  it('refuses a deciding human raising wake, and lets the system', async () => {
    const wake = {
      to: ['human:wyat'],
      kind: 'question' as const,
      blocking: true,
      choices: ['approve', 'deny'],
      body: 'wake?',
      data: { type: 'wake', target: 'task:t-000002', message: 'm-x' },
    };
    await expect(engine.send(wake, human)).rejects.toMatchObject({
      code: 'forbidden',
      field: 'data',
    });
    await engine.send(wake, system);
  });

  it('keeps scope to sessions and widens memory to deciding humans', () => {
    expect(GATE_RAISERS).toMatchObject({
      scope: 'session',
      memory: 'system-or-decider',
      wake: 'system',
      'task-proposal': 'system',
      doc: 'system',
    });
    const scope = {
      to: ['human:wyat'],
      kind: 'question' as const,
      blocking: true,
      choices: ['grant', 'deny'],
      body: 'more',
      data: { type: 'scope', paths: ['a.ts'], reason: 'r' },
    };
    expect(() => validateSendInput(scope, 'human:wyat', true, null)).toThrow(
      'only runs may request scope'
    );
    expect(() =>
      validateSendInput(scope, 'run:r-000001', false, null)
    ).not.toThrow();
  });
});
