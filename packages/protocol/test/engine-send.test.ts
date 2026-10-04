import type { SqliteDatabase } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { DeliveryEngine } from '../src/engine.js';
import type { SendInput } from '../src/envelope.js';
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

describe('the urgent quota', () => {
  it('is shared by every sender in the host quota group', async () => {
    engine = new DeliveryEngine({ store, host, limits: { urgentPerHour: 2 } });
    host.startRun('t-000002', 'r-000002');
    const run2 = { address: 'run:r-000002', canDecide: false };
    const group = [run1.address, run2.address];
    host.quotaGroups.set(run1.address, group);
    host.quotaGroups.set(run2.address, group);
    const urgent: SendInput = {
      to: ['human:wyat'],
      kind: 'message',
      body: 'x',
      urgent: true,
    };
    expect((await engine.send(urgent, run1)).downgraded).toBe(false);
    expect((await engine.send(urgent, run1)).downgraded).toBe(false);
    // A sibling run cannot reset the count by being a new address.
    const third = await engine.send(urgent, run2);
    expect(third.downgraded).toBe(true);
    expect(third.message.urgent).toBe(false);
  });
});

describe('opt-in guardrails', () => {
  it('caps the new threads an agent starts among agents in an hour', async () => {
    engine = new DeliveryEngine({
      store,
      host,
      limits: { agentThreadsPerHour: 2 },
    });
    const toAgent: SendInput = {
      to: ['task:t-000002'],
      kind: 'message',
      body: 'fresh',
    };
    await engine.send(toAgent, run1);
    await engine.send(toAgent, run1);
    await expect(engine.send(toAgent, run1)).rejects.toMatchObject({
      code: 'limited',
    });
    // A thread that includes a human is not an agent-to-agent thread.
    await engine.send(
      { to: ['human:wyat', 'task:t-000002'], kind: 'message', body: 'fyi' },
      run1
    );
    // And off by default, as the spec's breaker counts only replies.
    const open = new DeliveryEngine({ store, host });
    await open.send(toAgent, run1);
  });

  it('keeps one open wake gate per target', async () => {
    engine = new DeliveryEngine({
      store,
      host,
      limits: { openWakeGatesPerTarget: 1 },
    });
    host.ruling = 'ask';
    const wake: SendInput = {
      to: ['task:t-000009'],
      kind: 'message',
      body: 'wake up',
      wake: 'request',
    };
    await engine.send(wake, run1);
    await engine.send(wake, run1);
    const gates = engine
      .openBlocking()
      .filter(
        (m) => (m.data as { type?: string } | undefined)?.type === 'wake'
      );
    expect(gates.length).toBe(1);
  });
});
