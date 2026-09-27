import type { SqliteDatabase } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { DeliveryEngine } from '../src/engine.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';
import { FakeHost } from './fakeHost.js';

// Recovery lives in the kit's host-core vectors; this race needs FakeHost's
// push barrier, which no vector can hold open.
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

describe('recover', () => {
  it('does not count a row another path moves off sending first', async () => {
    host.startRun('t-000002', 'r-000002');
    store.insertMessage({
      id: 'm-d-4',
      thread: 'm-d-4',
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
      id: 'd-4',
      messageId: 'm-d-4',
      recipient: 'task:t-000002',
      runId: 'r-000002',
      via: 'direct',
      state: 'sending',
      updatedAt: at,
    });
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
