import type { SqliteDatabase } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { DeliveryEngine } from '../src/engine.js';
import { MessagingError } from '../src/errors.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';
import { FakeHost } from './fakeHost.js';

// Send behaviour lives in the kit's host-core vectors; these cases pin the
// TypeScript API around it: events, error class and listener isolation.
let db: SqliteDatabase;
let store: SqliteMessageStore;
let host: FakeHost;
let engine: DeliveryEngine;
const run1 = { address: 'run:r-000001', canDecide: false };

beforeEach(() => {
  db = openMessagesDb(':memory:');
  store = new SqliteMessageStore(db);
  host = new FakeHost();
  host.startRun('t-000001', 'r-000001');
  engine = new DeliveryEngine({ store, host });
});
afterEach(() => db.close());

describe('DeliveryEngine.send', () => {
  it('emits message and delivery events', async () => {
    const seen: string[] = [];
    engine.subscribe((e) => seen.push(e.type));
    await engine.send({ to: ['human:wyat'], kind: 'message', body: 'x' }, run1);
    expect(seen).toEqual(['message', 'delivery']);
  });

  it('surfaces validation errors as MessagingError', async () => {
    await expect(
      engine.send({ to: [], kind: 'message', body: 'x' }, run1)
    ).rejects.toBeInstanceOf(MessagingError);
  });

  it('isolates a throwing listener so send still resolves and delivers', async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      engine.subscribe(() => {
        throw new Error('boom');
      });
      host.startRun('t-000002', 'r-000002');
      const { deliveries } = await engine.send(
        { to: ['task:t-000002'], kind: 'message', body: 'x' },
        run1
      );
      expect(deliveries[0].state).toBe('pushed');
    } finally {
      console.error = originalError;
    }
  });
});
