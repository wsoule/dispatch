import type { SqliteDatabase } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { SYSTEM_ADDRESS } from '../src/address.js';
import { DeliveryEngine } from '../src/engine.js';
import { gateOf } from '../src/envelope.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';
import { FakeHost } from './fakeHost.js';

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

const wakeSend = () =>
  engine.send(
    {
      to: ['task:t-000003'],
      kind: 'message',
      body: 'please look\nmore',
      wake: 'request',
    },
    run1
  );

describe('wake', () => {
  it('allow calls host.wake', async () => {
    host.ruling = 'allow';
    await wakeSend();
    expect(host.hooks('wake')).toHaveLength(1);
  });

  it('allow with a failed wake tells the sender', async () => {
    host.ruling = 'allow';
    host.wakeResult = { ok: false, reason: 'task is blocked' };
    const { message } = await wakeSend();
    const notices = engine
      .inbox('run:r-000001')
      .filter((e) => e.message.from === SYSTEM_ADDRESS);
    expect(notices[0].message.body).toContain('task is blocked');
    expect(notices[0].message.refs).toEqual([
      { type: 'message', id: message.id },
    ]);
  });

  it('a failed-wake notice for a sender run that ended goes to its task', async () => {
    host.ruling = 'allow';
    host.wake = () => {
      host.endRun('t-000001');
      return Promise.resolve({ ok: false, reason: 'task is blocked' });
    };
    await wakeSend();
    const [notice] = engine
      .inbox('task:t-000001')
      .filter((e) => e.message.from === SYSTEM_ADDRESS);
    expect(notice.message.body).toContain('task is blocked');
    expect(notice.delivery.state).toBe('held');
  });

  it('deny keeps the message held and tells the sender', async () => {
    host.ruling = 'deny';
    const { deliveries } = await wakeSend();
    expect(deliveries[0].state).toBe('held');
    expect(host.hooks('wake')).toHaveLength(0);
    expect(
      engine
        .inbox('run:r-000001')
        .some((e) => e.message.body.includes('not allowed'))
    ).toBe(true);
  });

  it('ask sends a blocking wake gate to the owner', async () => {
    host.ruling = 'ask';
    const { message } = await wakeSend();
    const [gate] = engine.openBlocking();
    expect(gate).toMatchObject({
      from: SYSTEM_ADDRESS,
      to: ['human:wyat'],
      choices: ['approve', 'deny'],
    });
    expect(gateOf(gate)).toEqual({
      type: 'wake',
      target: 'task:t-000003',
      message: message.id,
    });
    expect(gate.body).toContain('please look');
    expect(gate.body).not.toContain('more');
  });

  it('the wake gate quotes the first line up to any line break', async () => {
    host.ruling = 'ask';
    await engine.send(
      {
        to: ['task:t-000003'],
        kind: 'message',
        body: 'please look\u2028more',
        wake: 'request',
      },
      run1
    );
    const [gate] = engine.openBlocking();
    expect(gate.body).toEndWith('> please look');
  });

  it('a first line as large as the body cap still raises the wake gate', async () => {
    host.ruling = 'ask';
    const { message } = await engine.send(
      {
        to: ['task:t-000003'],
        kind: 'message',
        body: 'x'.repeat(64 * 1024),
        wake: 'request',
      },
      run1
    );
    const [gate] = engine.openBlocking();
    expect(gateOf(gate)).toMatchObject({ type: 'wake', message: message.id });
    const quoted = gate.body.slice(gate.body.indexOf('> ') + 2);
    expect(quoted).toBe(`${'x'.repeat(79)}…`);
  });

  it('does not wake live recipients or when not requested', async () => {
    host.ruling = 'allow';
    host.startRun('t-000003', 'r-000003');
    await wakeSend();
    await engine.send(
      { to: ['task:t-000004'], kind: 'message', body: 'x' },
      run1
    );
    expect(host.hooks('decide')).toHaveLength(0);
  });
});

describe('waking one ended run', () => {
  const human = { address: 'human:wyat', canDecide: true };
  const toEndedRun = (sender: typeof human, wake?: 'request') =>
    engine.send(
      { to: ['run:r-00000a'], kind: 'message', body: 'rename foo', wake },
      sender
    );

  beforeEach(() => {
    host.runTasks.set('r-00000a', 't-000002');
  });

  it("holds a human's wake for the run and asks the host to wake exactly it", async () => {
    host.ruling = 'allow';
    const { message, deliveries } = await toEndedRun(human, 'request');
    expect(deliveries).toMatchObject([
      { recipient: 'run:r-00000a', state: 'held', runId: null },
    ]);
    expect(host.hooks('decide')).toEqual([['wake', 'run:r-00000a']]);
    expect(host.hooks('wake')).toEqual([['run:r-00000a', message.id]]);
  });

  it('tells the human why the run could not be continued', async () => {
    host.ruling = 'allow';
    host.wakeResult = { ok: false, reason: 'run has been merged' };
    await toEndedRun(human, 'request');
    const [notice] = engine
      .inbox('human:wyat')
      .filter((e) => e.message.from === SYSTEM_ADDRESS);
    expect(notice.message.body).toContain('run has been merged');
  });

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

  it("refuses an agent's wake or a human's plain message to it as not live", async () => {
    await expect(toEndedRun(run1, 'request')).rejects.toMatchObject({
      code: 'invalid',
      field: 'to[0]',
    });
    await expect(toEndedRun(human)).rejects.toMatchObject({
      code: 'invalid',
      field: 'to[0]',
    });
    expect(host.hooks('wake')).toEqual([]);
  });
});
