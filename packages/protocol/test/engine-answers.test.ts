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
const human = { address: 'human:wyat', canDecide: true };
const system = { address: SYSTEM_ADDRESS, canDecide: true };

beforeEach(() => {
  db = openMessagesDb(':memory:');
  store = new SqliteMessageStore(db);
  host = new FakeHost();
  host.startRun('t-000001', 'r-000001');
  engine = new DeliveryEngine({ store, host });
});
afterEach(() => db.close());

describe('answers', () => {
  it('reply answers a question, closes its deliveries and threads it', async () => {
    const { message: q } = await engine.send(
      {
        to: ['human:wyat'],
        kind: 'question',
        body: 'which?',
        blocking: true,
        choices: ['a', 'b'],
      },
      run1
    );
    const { message: a } = await engine.reply(
      q.id,
      { body: '', choice: 'a' },
      human
    );
    expect(a).toMatchObject({
      kind: 'answer',
      replyTo: q.id,
      thread: q.thread,
      to: ['run:r-000001'],
      choice: 'a',
    });
    expect(engine.answerOf(q.id)?.id).toBe(a.id);
    expect(store.deliveries({ messageId: q.id }).map((d) => d.state)).toEqual([
      'answered',
    ]);
    expect(engine.openBlocking()).toEqual([]);
    expect(host.hooks('push').at(-1)![0]).toBe('r-000001');
  });

  it('reply routes to the task when the asking run is gone', async () => {
    const { message: q } = await engine.send(
      { to: ['human:wyat'], kind: 'question', body: 'which?', blocking: true },
      run1
    );
    host.endRun('t-000001');
    const { message: a, deliveries } = await engine.reply(
      q.id,
      { body: 'b' },
      human
    );
    expect(a.to).toEqual(['task:t-000001']);
    expect(deliveries[0]).toMatchObject({
      recipient: 'task:t-000001',
      state: 'held',
    });
  });

  it('gate replies need canDecide and call onAnswered', async () => {
    const { message: gate } = await engine.send(
      {
        to: ['human:wyat'],
        kind: 'question',
        body: 'Run Bash?',
        blocking: true,
        choices: ['approve', 'deny'],
        data: {
          type: 'tool-approval',
          requestId: 'req-1',
          runId: 'r-000001',
          tool: 'Bash',
          input: {},
        },
      },
      system
    );
    await expect(
      engine.reply(
        gate.id,
        { body: '', choice: 'approve' },
        { address: 'human:wyat', canDecide: false }
      )
    ).rejects.toMatchObject({ code: 'forbidden' });
    await engine.reply(gate.id, { body: '', choice: 'approve' }, human);
    expect(host.hooks('onAnswered')).toEqual([[gate.id, 'approve']]);
  });

  it('plain questions do not call onAnswered', async () => {
    const { message: q } = await engine.send(
      { to: ['human:wyat'], kind: 'question', body: 'x?' },
      run1
    );
    await engine.reply(q.id, { body: 'y' }, human);
    expect(host.hooks('onAnswered')).toEqual([]);
  });

  it('close answers from the system without hooks', async () => {
    const { message: q } = await engine.send(
      {
        to: ['human:wyat'],
        kind: 'question',
        body: 'scope?',
        blocking: true,
        choices: ['grant', 'deny'],
        data: { type: 'scope', paths: ['a.ts'], reason: 'need it' },
      },
      run1
    );
    const closed = engine.close(q.id, 'the run ended');
    expect(closed).toMatchObject({
      from: SYSTEM_ADDRESS,
      kind: 'answer',
      replyTo: q.id,
      data: { type: 'x-closed', reason: 'the run ended' },
    });
    expect(engine.openBlocking()).toEqual([]);
    expect(host.hooks('onAnswered')).toEqual([]);
  });

  it('replying to a non-question sends a threaded message', async () => {
    const { message: m } = await engine.send(
      { to: ['human:wyat'], kind: 'notice', body: 'fyi' },
      run1
    );
    const { message: r } = await engine.reply(m.id, { body: 'thanks' }, human);
    expect(r).toMatchObject({
      kind: 'message',
      replyTo: m.id,
      thread: m.thread,
    });
  });
});

describe('held delivery and reads', () => {
  it('deliverHeld binds held task deliveries to the new run', async () => {
    const direct = await engine.send(
      { to: ['task:t-000002'], kind: 'message', body: 'direct' },
      run1
    );
    store.ensureChannel('auth', '2026-09-23T00:00:00.000Z', false);
    store.addMember('auth', 'task:t-000002', '2026-09-23T00:00:00.000Z');
    await engine.send(
      { to: ['channel:auth'], kind: 'notice', body: 'broadcast' },
      run1
    );
    host.startRun('t-000002', 'r-000002');
    const delivered = await engine.deliverHeld('r-000002', 't-000002');
    expect(delivered.map((d) => d.state).sort()).toEqual([
      'notified',
      'pushed',
    ]);
    expect(store.getDelivery(direct.deliveries[0].id)?.runId).toBe('r-000002');
  });

  it('inbox lists a mailbox with messages and markRead updates it', async () => {
    const agentAddr = 'agent:wyat/claude-code.macbook';
    await engine.send(
      { to: [agentAddr], kind: 'message', body: 'hello' },
      human
    );
    const [entry] = engine.inbox(agentAddr);
    expect(entry.message.body).toBe('hello');
    expect(engine.markRead(entry.delivery.id).state).toBe('read');
    expect(engine.inbox(agentAddr, ['held'])).toEqual([]);
  });

  it('join creates the channel and leave removes membership', () => {
    engine.join('auth', 'task:t-000009');
    expect(store.channels().map((c) => c.name)).toEqual(['auth']);
    expect(engine.leave('auth', 'task:t-000009')).toBe(true);
  });

  it('join rejects a run member because channel membership must outlive runs', () => {
    expect(() => engine.join('auth', 'run:r-000001')).toThrow(
      expect.objectContaining({ code: 'invalid', field: 'member' })
    );
  });
});
