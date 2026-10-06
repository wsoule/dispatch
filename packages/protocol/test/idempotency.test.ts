import type { SqliteDatabase } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { DeliveryEngine } from '../src/engine.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';
import type { AgentRecord } from '../src/store.js';
import { FakeHost } from './fakeHost.js';

const CLIENT = 'agent:wyat/a2a.acme';
const human = { address: 'human:wyat', canDecide: true };
const client = { address: CLIENT, canDecide: false };

function approved(address: string): AgentRecord {
  return {
    address,
    displayName: address,
    client: 'a2a',
    tokenHash: `hash-${address}`,
    status: 'approved',
    muted: false,
    approvedBy: 'human:wyat',
    createdAt: '2026-09-25T00:00:00.000Z',
  };
}

let db: SqliteDatabase;
let store: SqliteMessageStore;
let host: FakeHost;
let engine: DeliveryEngine;

beforeEach(() => {
  db = openMessagesDb(':memory:');
  store = new SqliteMessageStore(db);
  store.putAgent(approved(CLIENT));
  host = new FakeHost();
  engine = new DeliveryEngine({
    store,
    host,
    limits: { agentTurnsPerThreadPerHour: 2 },
  });
});
afterEach(() => db.close());

describe('durable idempotency keys', () => {
  it('replays the first message for a repeated key from the same sender', async () => {
    const first = await engine.send(
      {
        to: ['human:wyat'],
        kind: 'question',
        blocking: true,
        body: 'Is /sessions final?',
        idempotencyKey: 'msg-1',
      },
      client
    );
    const again = await engine.send(
      {
        to: ['human:wyat'],
        kind: 'question',
        blocking: true,
        body: 'a different body',
        idempotencyKey: 'msg-1',
      },
      client
    );
    expect(again.replayed).toBe(true);
    expect(again.message.id).toBe(first.message.id);
    expect(again.message.body).toBe('Is /sessions final?');
    expect(again.deliveries.map((d) => d.id)).toEqual(
      first.deliveries.map((d) => d.id)
    );
    expect(store.thread(first.message.thread)).toHaveLength(1);
  });

  it('runs no hooks on a replay', async () => {
    await engine.send(
      { to: ['human:wyat'], kind: 'message', body: 'hi', idempotencyKey: 'k' },
      client
    );
    const before = host.calls.length;
    await engine.send(
      { to: ['human:wyat'], kind: 'message', body: 'hi', idempotencyKey: 'k' },
      client
    );
    expect(host.calls.length).toBe(before);
  });

  it('keys per sender', async () => {
    store.putAgent(approved('agent:wyat/a2a.other'));
    const a = await engine.send(
      {
        to: ['human:wyat'],
        kind: 'message',
        body: 'a',
        idempotencyKey: 'same',
      },
      client
    );
    const b = await engine.send(
      {
        to: ['human:wyat'],
        kind: 'message',
        body: 'b',
        idempotencyKey: 'same',
      },
      { address: 'agent:wyat/a2a.other', canDecide: false }
    );
    expect(b.replayed).toBeUndefined();
    expect(b.message.id).not.toBe(a.message.id);
  });

  it('replays a retried answer instead of meeting conflict', async () => {
    const { message: q } = await engine.send(
      {
        to: [CLIENT],
        kind: 'question',
        blocking: true,
        body: 'Which region?',
        choices: ['us', 'eu'],
      },
      human
    );
    const first = await engine.send(
      {
        to: ['human:wyat'],
        kind: 'answer',
        replyTo: q.id,
        body: '',
        choice: 'eu',
        idempotencyKey: 'ans-1',
      },
      client
    );
    const retry = await engine.send(
      {
        to: ['human:wyat'],
        kind: 'answer',
        replyTo: q.id,
        body: '',
        choice: 'eu',
        idempotencyKey: 'ans-1',
      },
      client
    );
    expect(retry.replayed).toBe(true);
    expect(retry.message.id).toBe(first.message.id);
  });

  it('replays after the breaker trips instead of meeting limited', async () => {
    const { message: root } = await engine.send(
      { to: ['human:wyat'], kind: 'message', body: 'root' },
      client
    );
    const one = await engine.send(
      {
        to: ['human:wyat'],
        kind: 'message',
        replyTo: root.id,
        body: 'one',
        idempotencyKey: 'k1',
      },
      client
    );
    await expect(
      engine.send(
        {
          to: ['human:wyat'],
          kind: 'message',
          replyTo: root.id,
          body: 'two',
          idempotencyKey: 'k2',
        },
        client
      )
    ).rejects.toMatchObject({ code: 'limited' });
    const retry = await engine.send(
      {
        to: ['human:wyat'],
        kind: 'message',
        replyTo: root.id,
        body: 'one',
        idempotencyKey: 'k1',
      },
      client
    );
    expect(retry.message.id).toBe(one.message.id);
  });

  it('replays a duplicate that races the first send into its write', async () => {
    const send = () =>
      engine.send(
        { to: ['human:wyat'], kind: 'message', body: 'x', idempotencyKey: 'c' },
        client
      );
    const [a, b] = await Promise.all([send(), send()]);
    expect(b.message.id).toBe(a.message.id);
    expect(b.replayed).toBe(true);
    expect(store.thread(a.message.thread)).toHaveLength(1);
  });

  it('replays a duplicate answer that races the first into its write', async () => {
    const { message: q } = await engine.send(
      {
        to: [CLIENT],
        kind: 'question',
        blocking: true,
        body: 'Which region?',
        choices: ['us', 'eu'],
      },
      human
    );
    const answer = () =>
      engine.send(
        {
          to: ['human:wyat'],
          kind: 'answer',
          replyTo: q.id,
          body: '',
          choice: 'eu',
          idempotencyKey: 'ans-race',
        },
        client
      );
    const [a, b] = await Promise.all([answer(), answer()]);
    expect(b.replayed).toBe(true);
    expect(b.message.id).toBe(a.message.id);
    expect(store.answersTo(q.id)).toHaveLength(1);
  });

  it('looks the key up before validation, so a retry that no longer validates replays', async () => {
    const { message: q } = await engine.send(
      {
        to: [CLIENT],
        kind: 'question',
        blocking: true,
        body: 'Which region?',
        choices: ['us', 'eu'],
      },
      human
    );
    const first = await engine.send(
      {
        to: ['human:wyat'],
        kind: 'answer',
        replyTo: q.id,
        body: '',
        choice: 'eu',
        idempotencyKey: 'ans-v',
      },
      client
    );
    const retry = await engine.send(
      {
        to: ['human:wyat'],
        kind: 'answer',
        replyTo: q.id,
        body: '',
        choice: 'mars',
        idempotencyKey: 'ans-v',
      },
      client
    );
    expect(retry.replayed).toBe(true);
    expect(retry.message.id).toBe(first.message.id);
  });

  it('looks the key up before participation, so a retry naming a thread the sender is not in replays', async () => {
    store.putAgent(approved('agent:wyat/a2a.other'));
    const { message: elsewhere } = await engine.send(
      { to: ['agent:wyat/a2a.other'], kind: 'message', body: 'not for you' },
      human
    );
    const first = await engine.send(
      { to: ['human:wyat'], kind: 'message', body: 'hi', idempotencyKey: 'p' },
      client
    );
    const retry = await engine.send(
      {
        to: ['human:wyat'],
        kind: 'message',
        replyTo: elsewhere.id,
        body: 'hi',
        idempotencyKey: 'p',
      },
      client
    );
    expect(retry.replayed).toBe(true);
    expect(retry.message.id).toBe(first.message.id);
    expect(retry.message.replyTo).toBeNull();
  });

  it('gives a revoked sender no replay', async () => {
    await engine.send(
      { to: ['human:wyat'], kind: 'message', body: 'x', idempotencyKey: 'r' },
      client
    );
    store.putAgent({ ...approved(CLIENT), status: 'revoked' });
    await expect(
      engine.send(
        { to: ['human:wyat'], kind: 'message', body: 'x', idempotencyKey: 'r' },
        client
      )
    ).rejects.toMatchObject({ code: 'forbidden', field: 'from' });
  });

  it('refuses an empty key, a line break, or more than 200 UTF-8 bytes', async () => {
    for (const idempotencyKey of ['', 'a\nb', 'é'.repeat(101)]) {
      await expect(
        engine.send(
          { to: ['human:wyat'], kind: 'message', body: 'x', idempotencyKey },
          client
        )
      ).rejects.toMatchObject({ code: 'invalid', field: 'idempotencyKey' });
    }
  });
});
