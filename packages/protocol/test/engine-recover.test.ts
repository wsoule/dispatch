import type { SqliteDatabase } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { DeliveryEngine } from '../src/engine.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';
import { FakeHost } from './fakeHost.js';

let db: SqliteDatabase;
let store: SqliteMessageStore;
let host: FakeHost;
beforeEach(() => {
  db = openMessagesDb(':memory:');
  store = new SqliteMessageStore(db);
  host = new FakeHost();
});
afterEach(() => db.close());

const at = '2026-09-23T10:00:00.000Z';
function seedSending(
  deliveryId: string,
  runId: string,
  via: 'direct' | 'channel' = 'direct'
) {
  store.insertMessage({
    id: `m-${deliveryId}`,
    thread: `m-${deliveryId}`,
    replyTo: null,
    from: 'human:wyat',
    to: ['task:t-000002'],
    kind: 'message',
    body: 'x',
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: at,
  });
  store.insertDelivery({
    id: deliveryId,
    messageId: `m-${deliveryId}`,
    recipient: 'task:t-000002',
    runId,
    via,
    state: 'sending',
    updatedAt: at,
  });
}

describe('recover', () => {
  it('retries sending deliveries whose run is live', async () => {
    host.startRun('t-000002', 'r-000002');
    seedSending('d-1', 'r-000002');
    const engine = new DeliveryEngine({ store, host });
    expect(await engine.recover()).toEqual({
      retried: 1,
      reverted: 0,
      replayed: 0,
    });
    expect(store.getDelivery('d-1')?.state).toBe('pushed');
  });

  it('reverts sending deliveries whose run is gone to held', async () => {
    seedSending('d-2', 'r-00dead');
    const engine = new DeliveryEngine({ store, host });
    expect(await engine.recover()).toEqual({
      retried: 0,
      reverted: 1,
      replayed: 0,
    });
    expect(store.getDelivery('d-2')).toMatchObject({
      state: 'held',
      runId: null,
    });
  });

  it('leaves settled deliveries alone', async () => {
    seedSending('d-3', 'r-000002');
    store.setDelivery('d-3', 'pushed', 'r-000002', at);
    const engine = new DeliveryEngine({ store, host });
    expect(await engine.recover()).toEqual({
      retried: 0,
      reverted: 0,
      replayed: 0,
    });
  });

  it('does not count a row another path moves off sending first', async () => {
    host.startRun('t-000002', 'r-000002');
    seedSending('d-4', 'r-000002');
    const engine = new DeliveryEngine({ store, host });
    let release!: () => void;
    host.pushBarrier = new Promise((resolve) => (release = resolve));
    const recovering = engine.recover();
    await Promise.resolve();
    // Another path (e.g. a concurrent close) wins the sending->held CAS first.
    expect(store.setDelivery('d-4', 'held', null, at, 'sending')).toBe(true);
    release();
    expect(await recovering).toEqual({
      retried: 0,
      reverted: 0,
      replayed: 0,
    });
    expect(store.getDelivery('d-4')?.state).toBe('held');
  });
});

describe('recover gate replay', () => {
  const human = { address: 'human:wyat', canDecide: true };
  const system = { address: 'agent:dispatch', canDecide: true };
  async function sendGate(engine: DeliveryEngine) {
    const { message } = await engine.send(
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
    return message;
  }

  it('replays a gate answer whose onAnswered failed, then marks it applied', async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const engine = new DeliveryEngine({ store, host });
      const gate = await sendGate(engine);
      host.failOnAnswered = true;
      await engine.reply(gate.id, { body: '', choice: 'approve' }, human);
      host.failOnAnswered = false;
      expect(await engine.recover()).toEqual({
        retried: 0,
        reverted: 0,
        replayed: 1,
      });
      expect(host.hooks('onAnswered')).toEqual([
        [gate.id, 'approve'],
        [gate.id, 'approve'],
      ]);
      expect(await engine.recover()).toEqual({
        retried: 0,
        reverted: 0,
        replayed: 0,
      });
    } finally {
      console.error = originalError;
    }
  });

  it('does not replay an applied or closed gate', async () => {
    const engine = new DeliveryEngine({ store, host });
    const applied = await sendGate(engine);
    await engine.reply(applied.id, { body: '', choice: 'approve' }, human);
    const closed = await sendGate(engine);
    engine.close(closed.id, 'the run ended');
    expect(await engine.recover()).toEqual({
      retried: 0,
      reverted: 0,
      replayed: 0,
    });
    expect(host.hooks('onAnswered')).toEqual([[applied.id, 'approve']]);
  });
});
