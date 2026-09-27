import type { SqliteDatabase } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { DeliveryEngine } from '../src/engine.js';
import { MessagingError } from '../src/errors.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';
import { FakeHost } from './fakeHost.js';

let db: SqliteDatabase;
let store: SqliteMessageStore;
let host: FakeHost;
let engine: DeliveryEngine;
const run1 = { address: 'run:r-000001', canDecide: false };
const human = { address: 'human:wyat', canDecide: true };

beforeEach(() => {
  db = openMessagesDb(':memory:');
  store = new SqliteMessageStore(db);
  host = new FakeHost();
  host.startRun('t-000001', 'r-000001');
  engine = new DeliveryEngine({ store, host });
});
afterEach(() => db.close());

describe('DeliveryEngine.send', () => {
  it('pushes a direct message to a live task run', async () => {
    host.startRun('t-000002', 'r-000002');
    const { message, deliveries } = await engine.send(
      { to: ['task:t-000002'], kind: 'message', body: 'hi' },
      run1
    );
    expect(message.id).toMatch(/^m-[0-9a-z]{26}$/);
    expect(message.thread).toBe(message.id);
    expect(deliveries).toHaveLength(1);
    expect(store.getDelivery(deliveries[0].id)).toMatchObject({
      recipient: 'task:t-000002',
      runId: 'r-000002',
      state: 'pushed',
      via: 'direct',
    });
    expect(host.hooks('push')[0][0]).toBe('r-000002');
  });

  it('holds a message for a task with no live run', async () => {
    const { deliveries } = await engine.send(
      { to: ['task:t-000003'], kind: 'message', body: 'later' },
      run1
    );
    expect(deliveries[0]).toMatchObject({ state: 'held', runId: null });
    expect(host.hooks('push')).toHaveLength(0);
  });

  it('fails a direct send to a run that is not live', async () => {
    await expect(
      engine.send({ to: ['run:r-0000aa'], kind: 'message', body: 'x' }, human)
    ).rejects.toMatchObject({ code: 'invalid', field: 'to[0]' });
  });

  it("names the caller's own to[] entry after a reply rewrites and de-duplicates recipients", async () => {
    const { message: question } = await engine.send(
      { to: ['human:wyat'], kind: 'question', body: 'ok?' },
      run1
    );
    // run:r-000001 has ended, so a reply to it reaches task:t-000001 instead,
    // and that address collapses into the explicit first entry.
    host.endRun('t-000001');
    await expect(
      engine.send(
        {
          to: ['task:t-000001', 'run:r-000001', 'run:r-0000aa'],
          kind: 'message',
          body: 'see above',
          replyTo: question.id,
        },
        human
      )
    ).rejects.toMatchObject({ code: 'invalid', field: 'to[2]' });
  });

  it("names the caller's own to[] entry for an unknown channel after a reply collapses recipients", async () => {
    const { message: question } = await engine.send(
      { to: ['human:wyat'], kind: 'question', body: 'ok?' },
      run1
    );
    host.endRun('t-000001');
    await expect(
      engine.send(
        {
          to: ['task:t-000001', 'run:r-000001', 'channel:nope'],
          kind: 'message',
          body: 'see above',
          replyTo: question.id,
        },
        human
      )
    ).rejects.toMatchObject({ code: 'not-found', field: 'to[2]' });
  });

  it('notifies humans', async () => {
    const { deliveries } = await engine.send(
      { to: ['human:wyat'], kind: 'notice', body: 'fyi' },
      run1
    );
    expect(deliveries[0].state).toBe('notified');
    expect(host.hooks('notifyHuman')).toHaveLength(1);
  });

  it('holds messages for external agents in their mailbox', async () => {
    const { deliveries } = await engine.send(
      { to: ['agent:wyat/claude-code.macbook'], kind: 'message', body: 'x' },
      human
    );
    expect(deliveries[0].state).toBe('held');
  });

  it('notifies channel members instead of pushing', async () => {
    host.startRun('t-000002', 'r-000002');
    host.implicit.set('epic/e-000001', ['task:t-000001', 'task:t-000002']);
    const { deliveries } = await engine.send(
      { to: ['channel:epic/e-000001'], kind: 'notice', body: 'api changed' },
      run1
    );
    expect(deliveries.map((d) => [d.recipient, d.state, d.via])).toEqual([
      ['task:t-000002', 'notified', 'channel'],
    ]);
    expect(host.hooks('notify')).toHaveLength(1);
  });

  it("never delivers to the sender's own task", async () => {
    store.ensureChannel('auth', '2026-09-23T00:00:00.000Z', false);
    store.addMember('auth', 'task:t-000001', '2026-09-23T00:00:00.000Z');
    await expect(
      engine.send({ to: ['channel:auth'], kind: 'notice', body: 'x' }, run1)
    ).resolves.toMatchObject({ deliveries: [] });
  });

  it('pushes urgent channel messages', async () => {
    host.startRun('t-000002', 'r-000002');
    host.implicit.set('epic/e-000001', ['task:t-000002']);
    const { deliveries } = await engine.send(
      {
        to: ['channel:epic/e-000001'],
        kind: 'notice',
        body: 'stop',
        urgent: true,
      },
      run1
    );
    expect(deliveries[0].state).toBe('pushed');
  });

  it('a direct address beats the same recipient via a channel', async () => {
    host.startRun('t-000002', 'r-000002');
    host.implicit.set('epic/e-000001', ['task:t-000002']);
    const { deliveries } = await engine.send(
      {
        to: ['channel:epic/e-000001', 'task:t-000002'],
        kind: 'message',
        body: 'x',
      },
      run1
    );
    expect(deliveries.map((d) => d.via)).toEqual(['direct']);
  });

  it('rejects an unknown channel', async () => {
    await expect(
      engine.send({ to: ['channel:nope'], kind: 'message', body: 'x' }, run1)
    ).rejects.toMatchObject({ code: 'not-found', field: 'to[0]' });
  });

  it('reverts a failed push to held', async () => {
    host.startRun('t-000002', 'r-000002');
    host.failPushFor.add('r-000002');
    const { deliveries } = await engine.send(
      { to: ['task:t-000002'], kind: 'message', body: 'x' },
      run1
    );
    expect(store.getDelivery(deliveries[0].id)).toMatchObject({
      state: 'held',
      runId: null,
    });
  });

  it('rejects unapproved agents and accepts approved ones', async () => {
    const agent = {
      address: 'agent:wyat/claude-code.macbook',
      canDecide: false,
    };
    await expect(
      engine.send({ to: ['human:wyat'], kind: 'message', body: 'x' }, agent)
    ).rejects.toMatchObject({ code: 'forbidden' });
    store.putAgent({
      address: agent.address,
      displayName: 'x',
      client: 'c',
      tokenHash: 'h',
      status: 'approved',
      muted: false,
      approvedBy: 'human:wyat',
      createdAt: '2026-09-23T00:00:00.000Z',
    });
    await expect(
      engine.send({ to: ['human:wyat'], kind: 'message', body: 'x' }, agent)
    ).resolves.toBeDefined();
  });

  it('stores muted senders as read and calls no hooks', async () => {
    const agent = { address: 'agent:wyat/noisy', canDecide: false };
    store.putAgent({
      address: agent.address,
      displayName: 'noisy',
      client: 'c',
      tokenHash: 'h2',
      status: 'approved',
      muted: true,
      approvedBy: 'human:wyat',
      createdAt: '2026-09-23T00:00:00.000Z',
    });
    host.startRun('t-000002', 'r-000002');
    const { deliveries } = await engine.send(
      { to: ['task:t-000002', 'human:wyat'], kind: 'message', body: 'x' },
      agent
    );
    expect(deliveries.map((d) => d.state)).toEqual(['read', 'read']);
    expect(host.calls).toHaveLength(0);
  });

  it('gives handoffs accept/decline choices by default', async () => {
    const { message } = await engine.send(
      { to: ['task:t-000002'], kind: 'handoff', body: 'take it' },
      run1
    );
    expect(message.choices).toEqual(['accept', 'decline']);
  });

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

  it('skips a not-live run reached only via a channel, delivering to other live members', async () => {
    store.ensureChannel('auth', '2026-09-23T00:00:00.000Z', false);
    store.addMember('auth', 'run:r-0000dd', '2026-09-23T00:00:00.000Z');
    store.addMember('auth', 'task:t-000002', '2026-09-23T00:00:00.000Z');
    host.startRun('t-000002', 'r-000002');
    const { deliveries } = await engine.send(
      { to: ['channel:auth'], kind: 'notice', body: 'x' },
      run1
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ recipient: 'task:t-000002' });
  });

  it('reverts a failed notify on a channel delivery to held', async () => {
    host.startRun('t-000002', 'r-000002');
    host.implicit.set('epic/e-000001', ['task:t-000002']);
    host.failPushFor.add('r-000002');
    const { deliveries } = await engine.send(
      { to: ['channel:epic/e-000001'], kind: 'notice', body: 'x' },
      run1
    );
    expect(store.getDelivery(deliveries[0].id)).toMatchObject({
      state: 'held',
      runId: null,
    });
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
