import type { SqliteDatabase } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { SYSTEM_ADDRESS } from '../src/address.js';
import { DeliveryEngine } from '../src/engine.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';
import { FakeHost } from './fakeHost.js';

let db: SqliteDatabase;
let store: SqliteMessageStore;
let host: FakeHost;
let engine: DeliveryEngine;
const run1 = { address: 'run:r-000001', canDecide: false };
const run2 = { address: 'run:r-000002', canDecide: false };

beforeEach(() => {
  db = openMessagesDb(':memory:');
  store = new SqliteMessageStore(db);
  host = new FakeHost();
  host.startRun('t-000001', 'r-000001');
  host.startRun('t-000002', 'r-000002');
  engine = new DeliveryEngine({
    store,
    host,
    limits: { urgentPerHour: 2, agentTurnsPerThreadPerHour: 3 },
  });
});
afterEach(() => db.close());

describe('guardrails', () => {
  it('downgrades urgent over the hourly quota', async () => {
    const send = () =>
      engine.send(
        { to: ['task:t-000002'], kind: 'notice', body: 'x', urgent: true },
        run1
      );
    expect((await send()).downgraded).toBe(false);
    expect((await send()).downgraded).toBe(false);
    const third = await send();
    expect(third.downgraded).toBe(true);
    expect(third.message.urgent).toBe(false);
  });

  it('the quota window slides', async () => {
    for (let i = 0; i < 2; i++)
      await engine.send(
        { to: ['task:t-000002'], kind: 'notice', body: 'x', urgent: true },
        run1
      );
    host.clock = new Date(host.clock.getTime() + 61 * 60 * 1000);
    expect(
      (
        await engine.send(
          { to: ['task:t-000002'], kind: 'notice', body: 'x', urgent: true },
          run1
        )
      ).downgraded
    ).toBe(false);
  });

  it('humans are never downgraded', async () => {
    for (let i = 0; i < 3; i++) {
      expect(
        (
          await engine.send(
            { to: ['task:t-000002'], kind: 'notice', body: 'x', urgent: true },
            { address: 'human:wyat', canDecide: true }
          )
        ).downgraded
      ).toBe(false);
    }
  });

  it('breaks agent ping-pong and flags the owner once', async () => {
    const { message: root } = await engine.send(
      { to: ['task:t-000002'], kind: 'message', body: 'ping' },
      run1
    );
    await engine.reply(root.id, { body: 'pong' }, run2);
    await engine.reply(root.id, { body: 'ping' }, run1);
    await expect(
      engine.reply(root.id, { body: 'pong' }, run2)
    ).rejects.toMatchObject({ code: 'limited' });
    await expect(
      engine.reply(root.id, { body: 'pong' }, run2)
    ).rejects.toMatchObject({ code: 'limited' });
    const flags = store
      .thread(root.thread)
      .filter((m) => m.from === SYSTEM_ADDRESS);
    expect(flags).toHaveLength(1);
    expect(flags[0].to).toEqual(['human:wyat']);
  });

  it('humans can keep replying past the breaker', async () => {
    const { message: root } = await engine.send(
      { to: ['task:t-000002'], kind: 'message', body: 'ping' },
      run1
    );
    await engine.reply(root.id, { body: 'a' }, run2);
    await engine.reply(root.id, { body: 'b' }, run1);
    await expect(
      engine.reply(
        root.id,
        { body: 'c' },
        { address: 'human:wyat', canDecide: true }
      )
    ).resolves.toBeDefined();
  });
});
