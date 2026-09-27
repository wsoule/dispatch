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
