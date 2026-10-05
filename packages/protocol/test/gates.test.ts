import type { SqliteDatabase } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  GATE_RAISERS,
  GATE_TYPES,
  gateTypeOf,
  hasGateData,
  SYSTEM_ADDRESS,
} from '../src/constants.js';
import { DeliveryEngine } from '../src/engine.js';
import { validateSendInput } from '../src/envelope.js';
import type { Message, SendInput } from '../src/envelope.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';
import { FakeHost } from './fakeHost.js';

// Gate behaviour lives in the kit's host-core gates vectors; these cases pin
// the predicates, the raiser map and what depends on the engine's gateTypes.
const system = { address: SYSTEM_ADDRESS, canDecide: true };
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
  engine = new DeliveryEngine({ store, host, gateTypes: GATE_TYPES });
});
afterEach(() => db.close());

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

  it('leaves an answered gate of a type this engine does not know unapplied, for a build that does', async () => {
    const wakeOnly = new DeliveryEngine({ store, host });
    store.insertMessage({
      id: 'm-gate',
      thread: 'm-gate',
      replyTo: null,
      from: SYSTEM_ADDRESS,
      to: ['human:wyat'],
      kind: 'question',
      body: 'decide',
      refs: [],
      data: TOOL,
      urgent: false,
      blocking: true,
      choices: ['approve', 'deny'],
      wake: 'none',
      createdAt: T0,
    });
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

describe('raise authority (C5)', () => {
  it('refuses a deciding human raising task-proposal, and lets the system', () => {
    const proposal = {
      to: ['human:wyat'],
      kind: 'question' as const,
      blocking: true,
      choices: ['approve', 'decline'],
      body: 'approve?',
      data: {
        type: 'task-proposal',
        task: 't-a1b2c3',
        proposedBy: 'agent:wyat/a2a.acme',
        message: 'm-root',
      },
    };
    expect(() => validateSendInput(proposal, 'human:wyat', true, null)).toThrow(
      expect.objectContaining({ code: 'forbidden', field: 'data' })
    );
    expect(() =>
      validateSendInput(proposal, SYSTEM_ADDRESS, true, null)
    ).not.toThrow();
  });

  it('keeps scope to sessions and memory, like doc, to the system', () => {
    expect(GATE_RAISERS).toMatchObject({
      scope: 'session',
      memory: 'system',
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

describe('memory gates', () => {
  const data = {
    type: 'memory',
    proposalId: `mp-01K5Z6G${'0'.repeat(19)}`,
    action: 'add',
    scope: 'team',
    kind: 'hazard',
  };
  const memoryGate: SendInput = {
    to: ['human:wyat'],
    kind: 'question',
    body: 'run:r-9f2c01 proposes a team memory (hazard). Review it in Needs you.',
    blocking: true,
    choices: ['approve', 'reject'],
    data,
  };

  it('accepts the exact shape from the system', () => {
    expect(() =>
      validateSendInput(memoryGate, SYSTEM_ADDRESS, true, null)
    ).not.toThrow();
  });

  it('names the correct shape when it is wrong', () => {
    expect(() =>
      validateSendInput(
        { ...memoryGate, choices: ['yes', 'no'] },
        SYSTEM_ADDRESS,
        true,
        null
      )
    ).toThrow(
      'a memory gate is { kind: "question", blocking: true, choices: ["approve", "reject"]'
    );
    expect(() =>
      validateSendInput(
        { ...memoryGate, blocking: false },
        SYSTEM_ADDRESS,
        true,
        null
      )
    ).toThrow('a memory gate is');
    for (const [field, value] of [
      ['scope', 'personal'],
      ['proposalId', 'm-1'],
      ['action', 'delete'],
      ['kind', 'lesson'],
    ]) {
      expect(() =>
        validateSendInput(
          { ...memoryGate, data: { ...data, [field]: value } },
          SYSTEM_ADDRESS,
          true,
          null
        )
      ).toThrow(`data.${field}`);
    }
  });

  // GATE_RAISERS.memory ('system') refuses these (M5): a forged gate could
  // name a proposal the system never raised.
  it('may not be raised by a run, an agent or a deciding human', () => {
    expect(() =>
      validateSendInput(memoryGate, 'run:r-9f2c01', false, null)
    ).toThrow('only Dispatch may raise memory gates');
    expect(() =>
      validateSendInput(memoryGate, 'agent:wyat/claude', false, null)
    ).toThrow('only Dispatch may raise memory gates');
    expect(() =>
      validateSendInput(memoryGate, 'human:wyat', true, null)
    ).toThrow('only Dispatch may raise memory gates');
    expect(() =>
      validateSendInput(memoryGate, SYSTEM_ADDRESS, true, null)
    ).not.toThrow();
  });

  it('needs the decide tier to answer', () => {
    const question = {
      ...memoryGate,
      id: 'm-g',
      thread: 'm-g',
      replyTo: null,
      from: SYSTEM_ADDRESS,
      refs: [],
      urgent: false,
      wake: 'none',
      createdAt: T0,
    } as Message;
    expect(() =>
      validateSendInput(
        {
          to: [SYSTEM_ADDRESS],
          kind: 'answer',
          body: '',
          choice: 'approve',
          replyTo: 'm-g',
        },
        'human:ada',
        false,
        question
      )
    ).toThrow('decide tier');
  });
});
