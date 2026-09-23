import type { SqliteDatabase } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { DeliveryEngine } from '../src/engine.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';
import { FakeHost } from './fakeHost.js';

let db: SqliteDatabase;
let store: SqliteMessageStore;
let host: FakeHost;
let engine: DeliveryEngine;
const run1 = { address: 'run:r-000001', canDecide: false };
const human = { address: 'human:wyat', canDecide: true };

beforeEach(() => {
  db = openMessagesDb(':memory:');
  store = new SqliteMessageStore(db);
  host = new FakeHost();
  host.startRun('t-000001', 'r-000001');
  engine = new DeliveryEngine({ store, host });
});
afterEach(() => db.close());

describe('delivery races', () => {
  it('close during an in-flight push leaves the delivery answered', async () => {
    host.startRun('t-000002', 'r-000002');
    let release!: () => void;
    host.pushBarrier = new Promise((resolve) => (release = resolve));
    const sending = engine.send(
      { to: ['task:t-000002'], kind: 'question', body: 'which?' },
      run1
    );
    await Promise.resolve();
    const [q] = store.thread(
      store.deliveries({ recipient: 'task:t-000002' })[0].messageId
    );
    engine.close(q.id, 'no longer needed');
    release();
    const { deliveries } = await sending;
    expect(deliveries[0].state).toBe('answered');
    expect(store.getDelivery(deliveries[0].id)?.state).toBe('answered');
  });

  it('concurrent deliverHeld calls push each held message once', async () => {
    await engine.send(
      { to: ['task:t-000002'], kind: 'message', body: 'one' },
      run1
    );
    await engine.send(
      { to: ['task:t-000002'], kind: 'message', body: 'two' },
      run1
    );
    host.startRun('t-000002', 'r-000002');
    const [a, b] = await Promise.all([
      engine.deliverHeld('r-000002', 't-000002'),
      engine.deliverHeld('r-000002', 't-000002'),
    ]);
    expect(a.length + b.length).toBe(2);
    expect(host.hooks('push')).toHaveLength(2);
  });

  it('deliverHeld picks up a run delivery stranded by a failed push', async () => {
    host.startRun('t-000003', 'r-000003');
    host.failPushFor.add('r-000003');
    const { deliveries } = await engine.send(
      { to: ['run:r-000003'], kind: 'message', body: 'hi' },
      run1
    );
    expect(deliveries[0]).toMatchObject({ state: 'held', runId: null });
    host.endRun('t-000003');
    host.startRun('t-000003', 'r-000004');
    const delivered = await engine.deliverHeld('r-000004', 't-000003');
    expect(delivered).toHaveLength(1);
    expect(store.getDelivery(deliveries[0].id)).toMatchObject({
      state: 'pushed',
      runId: 'r-000004',
    });
  });

  it('a throwing wake policy does not reject a committed send', async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      host.decide = () => {
        throw new Error('policy exploded');
      };
      const { message } = await engine.send(
        {
          to: ['task:t-000002'],
          kind: 'message',
          body: 'wake up',
          wake: 'request',
        },
        human
      );
      expect(store.getMessage(message.id)).not.toBeNull();
    } finally {
      console.error = originalError;
    }
  });
});
