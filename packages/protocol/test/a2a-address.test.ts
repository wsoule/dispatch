import type { SqliteDatabase } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  isAgentAuthored,
  isPeerAddress,
  parseAddress,
  SYSTEM_ADDRESS,
} from '../src/address.js';
import { ADDRESS_SCHEMES } from '../src/constants.js';
import { DeliveryEngine } from '../src/engine.js';
import type { Message } from '../src/envelope.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';
import { FakeHost } from './fakeHost.js';

const PEER = 'a2a:acme';
const human = { address: 'human:wyat', canDecide: true };
const peer = { address: PEER, canDecide: false };
const run = { address: 'run:r-000001', canDecide: false };

let db: SqliteDatabase;
let store: SqliteMessageStore;
let host: FakeHost;
let engine: DeliveryEngine;

beforeEach(() => {
  db = openMessagesDb(':memory:');
  store = new SqliteMessageStore(db);
  host = new FakeHost();
  host.externals.set(PEER, 'peer');
  host.startRun('t-000001', 'r-000001');
  engine = new DeliveryEngine({
    store,
    host,
    limits: { agentTurnsPerThreadPerHour: 4 },
  });
});
afterEach(() => db.close());

describe('a2a: addresses', () => {
  it('parses an alias in the handle grammar, at most 40 characters', () => {
    expect(parseAddress('a2a:acme-planner.v2')).toEqual({
      kind: 'a2a',
      alias: 'acme-planner.v2',
      address: 'a2a:acme-planner.v2',
    });
    expect(parseAddress(`a2a:${'a'.repeat(40)}`).kind).toBe('a2a');
  });

  it.each([
    'a2a:',
    'a2a:Acme',
    'a2a:-acme',
    'a2a:ac me',
    `a2a:${'a'.repeat(41)}`,
  ])('refuses %j and names the field', (raw) => {
    expect(() => parseAddress(raw, 'to[0]')).toThrow(
      expect.objectContaining({ code: 'invalid', field: 'to[0]' })
    );
  });

  it('applies the 64-byte segment cap to the alias', () => {
    expect(() => parseAddress(`a2a:${'é'.repeat(33)}`, 'to')).toThrow(
      /alias is over 64 bytes/
    );
  });

  it('registers a2a as an address scheme', () => {
    expect(ADDRESS_SCHEMES).toContain('a2a');
  });

  it('counts peers as agent-authored, and only a2a: is a peer', () => {
    expect(isAgentAuthored(PEER)).toBe(true);
    expect(isAgentAuthored(SYSTEM_ADDRESS)).toBe(false);
    expect(isPeerAddress(PEER)).toBe(true);
    expect(isPeerAddress('agent:wyat/a2a.acme')).toBe(false);
  });
});

describe('delivering to a peer', () => {
  it('holds a direct peer delivery and relays it exactly once', async () => {
    const { deliveries } = await engine.send(
      { to: [PEER], kind: 'question', blocking: true, body: 'Which colour?' },
      human
    );
    expect(deliveries).toMatchObject([
      { recipient: PEER, state: 'held', runId: null, via: 'direct' },
    ]);
    const states: string[] = [];
    engine.subscribe((e) => {
      if (e.type === 'delivery') states.push(e.delivery.state);
    });
    expect(engine.markRelayed(deliveries[0].id)?.state).toBe('pushed');
    expect(engine.markRelayed(deliveries[0].id)).toBeNull();
    expect(states).toEqual(['pushed']);
  });

  it('never relays a delivery that is not a held peer delivery', async () => {
    const { deliveries } = await engine.send(
      { to: ['human:alice'], kind: 'message', body: 'hi' },
      human
    );
    expect(engine.markRelayed(deliveries[0].id)).toBeNull();
    expect(engine.markRelayed('d-missing')).toBeNull();
  });

  it('holds a peer that a channel reaches', async () => {
    engine.join('ops', PEER);
    engine.join('ops', 'human:alice');
    const { deliveries } = await engine.send(
      { to: ['channel:ops'], kind: 'message', body: 'standup' },
      human
    );
    expect(deliveries.find((d) => d.recipient === PEER)).toMatchObject({
      state: 'held',
      via: 'channel',
    });
  });

  it('lets a peer answer the question it was sent', async () => {
    const { message: q } = await engine.send(
      { to: [PEER], kind: 'question', blocking: true, body: 'Which colour?' },
      human
    );
    const { message: a } = await engine.send(
      { to: ['human:wyat'], kind: 'answer', replyTo: q.id, body: 'Blue.' },
      peer
    );
    expect(engine.answerOf(q.id)?.id).toBe(a.id);
  });

  it('counts the messages delivered to a peer since a time', async () => {
    await engine.send({ to: [PEER], kind: 'message', body: 'one' }, human);
    await engine.send(
      { to: [PEER, 'human:alice'], kind: 'message', body: 'two' },
      human
    );
    await engine.send(
      { to: ['human:alice'], kind: 'message', body: 'not the peer' },
      human
    );
    expect(store.countDeliveredTo(PEER, '2026-09-23T09:00:00.000Z')).toBe(2);
    expect(store.countDeliveredTo(PEER, '2026-09-23T11:00:00.000Z')).toBe(0);
  });
});

describe('the breaker counts peers', () => {
  it('trips a run↔peer loop on the fifth agent turn in a thread', async () => {
    let last: Message = (
      await engine.send({ to: [PEER], kind: 'message', body: 'ping' }, run)
    ).message;
    for (const [sender, to] of [
      [peer, 'run:r-000001'],
      [run, PEER],
      [peer, 'run:r-000001'],
    ] as const) {
      last = (
        await engine.send(
          { to: [to], kind: 'message', replyTo: last.id, body: 'pong' },
          sender
        )
      ).message;
    }
    await expect(
      engine.send(
        { to: [PEER], kind: 'message', replyTo: last.id, body: 'again' },
        run
      )
    ).rejects.toMatchObject({ code: 'limited', field: 'replyTo' });
    expect(
      store
        .thread(last.thread)
        .some(
          (m) =>
            m.from === SYSTEM_ADDRESS &&
            (m.data as { type?: string } | undefined)?.type === 'x-breaker'
        )
    ).toBe(true);
  });
});
