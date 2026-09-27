import type { SqliteDatabase } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { DeliveryEngine } from '../src/engine.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';
import { FakeHost } from './fakeHost.js';

let db: SqliteDatabase;
let host: FakeHost;
let engine: DeliveryEngine;

beforeEach(() => {
  db = openMessagesDb(':memory:');
  host = new FakeHost();
  host.startRun('t-000001', 'r-000001');
  engine = new DeliveryEngine({ store: new SqliteMessageStore(db), host });
});
afterEach(() => db.close());

describe('waking one ended run', () => {
  const human = { address: 'human:wyat', canDecide: true };

  // Held mail to a run is only ever delivered through its task, so a run the
  // host cannot place would hold the message forever.
  it("refuses a human's wake of a run that belongs to no task", async () => {
    host.ruling = 'allow';
    await expect(
      engine.send(
        {
          to: ['task:t-000002', 'run:r-0000ff'],
          kind: 'message',
          body: 'rename foo',
          wake: 'request',
        },
        human
      )
    ).rejects.toMatchObject({ code: 'invalid', field: 'to[1]' });
    expect(host.hooks('wake')).toEqual([]);
  });
});
