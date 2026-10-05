import type { SqliteDatabase } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { SYSTEM_ADDRESS } from '../src/address.js';
import { DeliveryEngine } from '../src/engine.js';
import type { EngineEvent, Sender } from '../src/engine.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';
import { FakeFederation, FakeHost } from './fakeHost.js';

const ME = 'wyat-0000000a';
const BOB = 'bob-0000000b';
const TASK = 'task:t-00000a01';
const human: Sender = { address: 'human:wyat', canDecide: true };
const SYSTEM: Sender = { address: SYSTEM_ADDRESS, canDecide: true };
const WAKE_GATE = { type: 'wake', target: TASK, message: 'm-x' };

let db: SqliteDatabase;
let store: SqliteMessageStore;
let host: FakeHost;
let fed: FakeFederation;
let engine: DeliveryEngine;
let events: EngineEvent[];

beforeEach(() => {
  db = openMessagesDb(':memory:');
  store = new SqliteMessageStore(db);
  host = new FakeHost();
  fed = new FakeFederation(ME);
  host.federation = fed;
  engine = new DeliveryEngine({ store, host });
  events = [];
  engine.subscribe((e) => events.push(e));
});
afterEach(() => db.close());

describe('send with federation hooks', () => {
  it('without hooks stamps no clock and writes no remote rows', async () => {
    host.federation = undefined;
    const { message } = await engine.send(
      { to: ['human:bob'], kind: 'message', body: 'hi' },
      human
    );
    expect(message.hlc).toBeUndefined();
    expect(store.remoteDeliveries({ messageId: message.id })).toEqual([]);
    expect(store.deliveries({ messageId: message.id })[0]?.state).toBe(
      'notified'
    );
  });

  it('stamps message.hlc from the hook and stores it', async () => {
    const { message } = await engine.send(
      { to: ['human:bob'], kind: 'message', body: 'hi' },
      human
    );
    expect(message.hlc).toBe(`1758880000000.0001.${ME}`);
    expect(store.getMessage(message.id)?.hlc).toBe(message.hlc);
  });

  it('records a forwarded remote row and no local delivery for a target homed elsewhere', async () => {
    fed.placements.set('human:bob', {
      kind: 'remote',
      homes: [BOB],
      alsoLocal: false,
    });
    const { message, deliveries } = await engine.send(
      { to: ['human:bob'], kind: 'message', body: 'hi' },
      human
    );
    expect(deliveries).toEqual([]);
    expect(store.remoteDeliveries({ messageId: message.id })).toEqual([
      expect.objectContaining({
        recipient: 'human:bob',
        state: 'forwarded',
        homes: [BOB],
        wakeAt: null,
      }),
    ]);
    expect(host.hooks('notifyHuman')).toEqual([]);
    expect(events).toContainEqual({
      type: 'remote',
      messageId: message.id,
      recipient: 'human:bob',
    });
  });

  it('also plans a local delivery when this replica is one of the homes', async () => {
    fed.placements.set('human:ada', {
      kind: 'remote',
      homes: [ME, BOB],
      alsoLocal: true,
    });
    const { message, deliveries } = await engine.send(
      { to: ['human:ada'], kind: 'message', body: 'hi' },
      human
    );
    expect(deliveries.map((d) => [d.recipient, d.state])).toEqual([
      ['human:ada', 'notified'],
    ]);
    expect(store.remoteDeliveries({ messageId: message.id })).toHaveLength(1);
  });

  it('refuses a local-only direct target on its to[i] and skips a channel-expanded one', async () => {
    fed.placements.set('human:bob', { kind: 'refuse', reason: 'local-only' });
    await expect(
      engine.send(
        { to: ['human:ada', 'human:bob'], kind: 'message', body: 'x' },
        human
      )
    ).rejects.toMatchObject({ code: 'forbidden', field: 'to[1]' });
    engine.join('ops', 'human:ada');
    engine.join('ops', 'human:bob');
    const { deliveries } = await engine.send(
      { to: ['channel:ops'], kind: 'message', body: 'y' },
      human
    );
    expect(deliveries.map((d) => d.recipient)).toEqual(['human:ada']);
  });

  it('refuses gate data bound off the machine with one error on data', async () => {
    fed.placements.set('human:bob', { kind: 'refuse', reason: 'local-only' });
    await expect(
      engine.send(
        {
          to: ['human:bob'],
          kind: 'question',
          blocking: true,
          choices: ['approve', 'deny'],
          body: 'wake?',
          data: WAKE_GATE,
        },
        SYSTEM
      )
    ).rejects.toMatchObject({
      code: 'forbidden',
      field: 'data',
      message: 'gates never leave this machine',
    });
  });

  it('gives gate data bound for an A2A client the same error on data', async () => {
    host.externals.set('agent:wyat/a2a.acme', 'client');
    await expect(
      engine.send(
        {
          to: ['agent:wyat/a2a.acme'],
          kind: 'question',
          blocking: true,
          choices: ['approve', 'deny'],
          body: 'wake?',
          data: WAKE_GATE,
        },
        SYSTEM
      )
    ).rejects.toMatchObject({ code: 'forbidden', field: 'data' });
  });

  it('keeps gate data on this machine whatever placement says', async () => {
    fed.placements.set('human:ada', {
      kind: 'remote',
      homes: [ME, BOB],
      alsoLocal: true,
    });
    const gate = {
      kind: 'question' as const,
      blocking: true,
      choices: ['approve', 'deny'],
      body: 'wake?',
      data: WAKE_GATE,
    };
    const { message, deliveries } = await engine.send(
      { ...gate, to: ['human:ada'] },
      SYSTEM
    );
    expect(deliveries.map((d) => d.recipient)).toEqual(['human:ada']);
    expect(store.remoteDeliveries({ messageId: message.id })).toEqual([]);
    fed.placements.set('human:bob', {
      kind: 'remote',
      homes: [BOB],
      alsoLocal: false,
    });
    await expect(
      engine.send({ ...gate, to: ['human:bob'] }, SYSTEM)
    ).rejects.toMatchObject({ code: 'forbidden', field: 'data' });
  });

  it('skips its own wake when wakeAt names another replica', async () => {
    host.ruling = 'allow';
    fed.placements.set(TASK, {
      kind: 'remote',
      homes: [ME, BOB],
      alsoLocal: true,
      wakeAt: BOB,
    });
    await engine.send(
      { to: [TASK], kind: 'message', body: 'pick this up', wake: 'request' },
      human
    );
    expect(host.hooks('decide')).toEqual([]);
    expect(host.hooks('wake')).toEqual([]);
    expect(store.deliveries({ recipient: TASK })[0]?.state).toBe('held');
    expect(store.remoteDeliveries({ recipient: TASK })[0]?.wakeAt).toBe(BOB);
  });

  it('runs its own wake when wakeAt names this replica', async () => {
    host.ruling = 'allow';
    fed.placements.set(TASK, {
      kind: 'remote',
      homes: [ME, BOB],
      alsoLocal: true,
      wakeAt: ME,
    });
    const { message } = await engine.send(
      { to: [TASK], kind: 'message', body: 'pick this up', wake: 'request' },
      human
    );
    expect(host.hooks('wake')).toEqual([[TASK, message.id]]);
    expect(host.requests.at(-1)?.origin).toBeUndefined();
  });

  it('reaches a run on another replica through its task, and leaves an unknown run as it is', () => {
    fed.remoteRuns.set('r-0000000000ab', 't-00000a01');
    expect(engine.deliverableAddress('run:r-0000000000ab')).toBe(TASK);
    expect(engine.deliverableAddress('run:r-0000000000ff')).toBe(
      'run:r-0000000000ff'
    );
  });

  it('emits membership events after join and leave commit', () => {
    engine.join('ops', 'human:bob');
    expect(engine.leave('ops', 'human:bob')).toBe(true);
    expect(engine.leave('ops', 'human:bob')).toBe(false);
    expect(events.filter((e) => e.type === 'membership')).toEqual([
      { type: 'membership', channel: 'ops', member: 'human:bob', joined: true },
      {
        type: 'membership',
        channel: 'ops',
        member: 'human:bob',
        joined: false,
      },
    ]);
  });

  it('emits no membership event for a join that changes nothing', () => {
    engine.join('ops', 'human:bob');
    engine.join('ops', 'human:bob');
    expect(events.filter((e) => e.type === 'membership')).toHaveLength(1);
  });

  it('a system close sorts after its question with hooks on', async () => {
    const { message: q } = await engine.send(
      { to: ['human:bob'], kind: 'question', body: 'which way?' },
      human
    );
    const closed = engine.close(q.id, 'the run ended');
    expect(closed.hlc).toBe(`1758880000000.0002.${ME}`);
    expect(store.getMessage(closed.id)?.hlc).toBe(closed.hlc);
    expect(store.thread(q.thread).map((m) => m.id)).toEqual([q.id, closed.id]);
  });

  it("reads one message's local deliveries", async () => {
    const { message } = await engine.send(
      { to: ['human:ada', 'human:bob'], kind: 'message', body: 'x' },
      human
    );
    expect(
      engine
        .deliveriesOf(message.id)
        .map((d) => d.recipient)
        .sort()
    ).toEqual(['human:ada', 'human:bob']);
  });
});
