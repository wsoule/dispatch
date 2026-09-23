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
    expect(await engine.recover()).toEqual({ retried: 1, reverted: 0 });
    expect(store.getDelivery('d-1')?.state).toBe('pushed');
  });

  it('reverts sending deliveries whose run is gone to held', async () => {
    seedSending('d-2', 'r-00dead');
    const engine = new DeliveryEngine({ store, host });
    expect(await engine.recover()).toEqual({ retried: 0, reverted: 1 });
    expect(store.getDelivery('d-2')).toMatchObject({
      state: 'held',
      runId: null,
    });
  });

  it('leaves settled deliveries alone', async () => {
    seedSending('d-3', 'r-000002');
    store.setDelivery('d-3', 'pushed', 'r-000002', at);
    const engine = new DeliveryEngine({ store, host });
    expect(await engine.recover()).toEqual({ retried: 0, reverted: 0 });
  });
});
