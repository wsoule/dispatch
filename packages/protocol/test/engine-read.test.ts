import type { SqliteDatabase } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { SYSTEM_ADDRESS } from '../src/address.js';
import { DeliveryEngine } from '../src/engine.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';
import { FakeHost } from './fakeHost.js';

// The per-message read rule is a kit vector (canRead); the kit has no thread
// read step, so the thread predicate is pinned here.
let db: SqliteDatabase;
let store: SqliteMessageStore;
let host: FakeHost;
let engine: DeliveryEngine;
const run1 = { address: 'run:r-000001', canDecide: false };
const run2 = { address: 'run:r-000002', canDecide: false };
const run9 = { address: 'run:r-000009', canDecide: false };
const human = { address: 'human:wyat', canDecide: true };
const system = { address: SYSTEM_ADDRESS, canDecide: true };

beforeEach(() => {
  db = openMessagesDb(':memory:');
  store = new SqliteMessageStore(db);
  host = new FakeHost();
  host.startRun('t-000001', 'r-000001');
  host.startRun('t-000002', 'r-000002');
  host.startRun('t-000009', 'r-000009');
  engine = new DeliveryEngine({ store, host });
});
afterEach(() => db.close());

describe('DeliveryEngine.canReadThread', () => {
  it('lets a participant of any message read the thread, and no bystander', async () => {
    const { message: first } = await engine.send(
      { to: ['human:wyat'], kind: 'message', body: 'status?' },
      run1
    );
    await engine.send(
      {
        to: ['task:t-000002'],
        kind: 'message',
        body: 'looping in t-000002',
        replyTo: first.id,
      },
      human
    );
    expect(engine.canReadThread(first.thread, run1)).toBe(true);
    expect(engine.canReadThread(first.thread, run2)).toBe(true);
    expect(engine.canReadThread(first.thread, run9)).toBe(false);
  });

  it('lets a deciding human and the system read any thread that exists', async () => {
    const { message } = await engine.send(
      { to: ['task:t-000002'], kind: 'message', body: 'private' },
      run1
    );
    expect(engine.canReadThread(message.thread, human)).toBe(true);
    expect(engine.canReadThread(message.thread, system)).toBe(true);
  });

  it('reads an absent thread as unreadable to everyone', () => {
    for (const sender of [run1, run9, human, system])
      expect(engine.canReadThread('m-absent', sender)).toBe(false);
  });
});
