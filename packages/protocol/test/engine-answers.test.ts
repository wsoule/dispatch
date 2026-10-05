import type { SqliteDatabase } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { SYSTEM_ADDRESS } from '../src/address.js';
import { DeliveryEngine } from '../src/engine.js';
import { GATE_TYPES } from '../src/envelope.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';
import { FakeHost } from './fakeHost.js';

// Answer, reply and participation behaviour lives in the kit's host-core
// vectors; these cases pin engine internals.
let db: SqliteDatabase;
let store: SqliteMessageStore;
let host: FakeHost;
let engine: DeliveryEngine;
const human = { address: 'human:wyat', canDecide: true };
const system = { address: SYSTEM_ADDRESS, canDecide: true };

beforeEach(() => {
  db = openMessagesDb(':memory:');
  store = new SqliteMessageStore(db);
  host = new FakeHost();
  host.startRun('t-000001', 'r-000001');
  engine = new DeliveryEngine({ store, host, gateTypes: GATE_TYPES });
});
afterEach(() => db.close());

describe('answers', () => {
  it('deliverableAddress sends a run that ended to its task', () => {
    expect(engine.deliverableAddress('run:r-000001')).toBe('run:r-000001');
    host.endRun('t-000001');
    expect(engine.deliverableAddress('run:r-000001')).toBe('task:t-000001');
    expect(engine.deliverableAddress('run:r-0000ff')).toBe('run:r-0000ff');
    expect(engine.deliverableAddress('human:wyat')).toBe('human:wyat');
  });

  it('a throwing markGateApplied does not fail the reply', async () => {
    const originalError = console.error;
    const logged: unknown[] = [];
    console.error = (label: unknown) => logged.push(label);
    try {
      let thrown = false;
      const originalMarkGateApplied = store.markGateApplied.bind(store);
      store.markGateApplied = (questionId, at) => {
        if (!thrown) {
          thrown = true;
          throw new Error('disk full');
        }
        originalMarkGateApplied(questionId, at);
      };
      const { message: gate } = await engine.send(
        {
          to: ['human:wyat'],
          kind: 'question',
          body: 'Run Bash?',
          blocking: true,
          choices: ['approve', 'deny'],
          data: {
            type: 'tool-approval',
            requestId: 'req-1',
            runId: 'r-000001',
            tool: 'Bash',
            input: {},
          },
        },
        system
      );
      const { message: a } = await engine.reply(
        gate.id,
        { body: '', choice: 'approve' },
        human
      );
      // send() still committed and emitted the answer despite the store failure.
      expect(a.kind).toBe('answer');
      expect(engine.answerOf(gate.id)?.id).toBe(a.id);
      expect(host.hooks('onAnswered')).toEqual([[gate.id, 'approve']]);
      expect(logged).toEqual(['messaging markGateApplied failed']);
      // Not recorded as applied, so recover() replays it.
      expect(await engine.recover()).toMatchObject({ replayed: 1 });
    } finally {
      console.error = originalError;
    }
  });
});
