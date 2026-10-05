import type { SqliteDatabase } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { SYSTEM_ADDRESS } from '../src/address.js';
import { DeliveryEngine } from '../src/engine.js';
import type { Message } from '../src/envelope.js';
import { MessagingError } from '../src/errors.js';
import { renderDigestLine, renderForAgent } from '../src/render.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';
import { FakeHost } from './fakeHost.js';

const CLIENT = 'agent:wyat/a2a.acme';
const SYSTEM = { address: SYSTEM_ADDRESS, canDecide: true };
const human = { address: 'human:wyat', canDecide: true };
const client = { address: CLIENT, canDecide: false };
const WAKE_GATE = { type: 'wake', target: 'task:t-000001', message: 'm-x' };

let db: SqliteDatabase;
let store: SqliteMessageStore;
let host: FakeHost;
let engine: DeliveryEngine;

beforeEach(() => {
  db = openMessagesDb(':memory:');
  store = new SqliteMessageStore(db);
  store.putAgent({
    address: CLIENT,
    displayName: 'acme',
    client: 'a2a',
    tokenHash: 'h',
    status: 'approved',
    muted: false,
    approvedBy: 'human:wyat',
    createdAt: '2026-09-25T00:00:00.000Z',
  });
  host = new FakeHost();
  host.externals.set(CLIENT, 'client');
  engine = new DeliveryEngine({ store, host });
});
afterEach(() => db.close());

describe('external recipients', () => {
  it('refuses gate data addressed to an A2A client before storing anything', async () => {
    await expect(
      engine.send(
        {
          to: [CLIENT],
          kind: 'question',
          blocking: true,
          choices: ['approve', 'deny'],
          body: 'wake?',
          data: WAKE_GATE,
        },
        SYSTEM
      )
    ).rejects.toMatchObject({ code: 'forbidden', field: 'data' });
    expect(store.deliveries({})).toHaveLength(0);
    expect(store.openBlocking()).toHaveLength(0);
  });

  it('refuses gate data sent to a channel that holds an A2A client', async () => {
    engine.join('ops', CLIENT);
    engine.join('ops', 'human:alice');
    await expect(
      engine.send(
        {
          to: ['channel:ops'],
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

  it('an x-less unknown-typed question to a client is refused on data', async () => {
    const wide = new DeliveryEngine({
      store,
      host,
      gateTypes: ['wake', 'future-gate'],
    });
    await expect(
      wide.send(
        {
          to: [CLIENT],
          kind: 'question',
          blocking: true,
          choices: ['approve', 'deny'],
          body: 'decide?',
          data: { type: 'future-gate', ref: 'x' },
        },
        SYSTEM
      )
    ).rejects.toMatchObject({ code: 'forbidden', field: 'data' });
    expect(store.deliveries({})).toHaveLength(0);
  });

  it('an answer to a gate is not sent to a client', async () => {
    const { message: gate } = await engine.send(
      {
        to: ['human:wyat'],
        kind: 'question',
        blocking: true,
        choices: ['approve', 'deny'],
        body: 'wake?',
        data: WAKE_GATE,
      },
      SYSTEM
    );
    await expect(
      engine.send(
        {
          to: [CLIENT],
          kind: 'answer',
          replyTo: gate.id,
          body: '',
          choice: 'approve',
        },
        human
      )
    ).rejects.toMatchObject({ code: 'forbidden', field: 'data' });
    expect(engine.answerOf(gate.id)).toBeNull();
  });

  it('fails a direct send the host refuses, and names the caller’s field', async () => {
    host.admit = (target) => {
      throw new MessagingError(
        'invalid',
        'A2A clients are reachable only inside their own tasks',
        target.field
      );
    };
    await expect(
      engine.send(
        { to: ['human:bob', CLIENT], kind: 'message', body: 'hi' },
        human
      )
    ).rejects.toMatchObject({ code: 'invalid', field: 'to[1]' });
  });

  it('skips a channel member the host refuses and delivers to the rest', async () => {
    engine.join('ops', CLIENT);
    engine.join('ops', 'human:alice');
    host.admit = () => {
      throw new MessagingError('invalid', 'not in scope', 'to[0]');
    };
    const { deliveries } = await engine.send(
      { to: ['channel:ops'], kind: 'message', body: 'hi' },
      human
    );
    expect(deliveries.map((d) => d.recipient)).toEqual(['human:alice']);
  });

  it("gives no delivery to a target the host answers 'skip' for", async () => {
    host.admit = () => 'skip';
    const { deliveries } = await engine.send(
      { to: [CLIENT, 'human:bob'], kind: 'message', body: 'hi' },
      human
    );
    expect(deliveries.map((d) => d.recipient)).toEqual(['human:bob']);
  });
});

describe('system-only markers', () => {
  it('applies a gate effect when a deciding human answers with x-closed-looking data', async () => {
    const { message: gate } = await engine.send(
      {
        to: ['human:wyat'],
        kind: 'question',
        blocking: true,
        choices: ['approve', 'deny'],
        body: 'wake?',
        data: WAKE_GATE,
      },
      SYSTEM
    );
    await engine.send(
      {
        to: [SYSTEM_ADDRESS],
        kind: 'answer',
        replyTo: gate.id,
        body: 'ok',
        choice: 'approve',
        data: { type: 'x-closed', reason: 'forged' },
      },
      human
    );
    expect(host.hooks('onAnswered')).toHaveLength(1);
  });

  it('keeps a system close free of gate effects', async () => {
    const { message: gate } = await engine.send(
      {
        to: ['human:wyat'],
        kind: 'question',
        blocking: true,
        choices: ['approve', 'deny'],
        body: 'wake?',
        data: WAKE_GATE,
      },
      SYSTEM
    );
    engine.close(gate.id, 'the run ended');
    expect(host.hooks('onAnswered')).toHaveLength(0);
    expect(store.unappliedAnsweredGates()).toHaveLength(0);
  });
});

describe('external rendering', () => {
  const base: Message = {
    id: 'm-x',
    thread: 'm-x',
    replyTo: null,
    from: CLIENT,
    to: ['task:t-000001'],
    kind: 'question',
    body: 'line one\nline two',
    refs: [{ type: 'message', id: 'm-1' }],
    choices: ['a', 'b'],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-09-25T00:00:00.000Z',
  };

  it('marks the sender external and quotes every carried line', () => {
    const lines = renderForAgent(base, true).split('\n');
    expect(lines[0]).toBe(
      `[message from ${CLIENT} (external) · question · m-x]`
    );
    expect(lines).toContain('│ choices: a | b');
    expect(lines).toContain('│ refs: message:m-1');
    expect(lines.slice(1).every((l) => l.startsWith('│ '))).toBe(true);
  });

  it('leaves internal rendering unchanged', () => {
    expect(renderForAgent({ ...base, from: 'run:r-000001' })).toContain(
      '\nchoices: a | b'
    );
  });

  it('marks an external digest line', () => {
    expect(renderDigestLine(base, true)).toContain(
      `from ${CLIENT} (external):`
    );
  });

  it('pushes an external sender’s message rendered as external', async () => {
    host.startRun('t-000001', 'r-000001');
    await engine.send(
      { to: ['task:t-000001'], kind: 'message', body: 'from outside' },
      client
    );
    expect(String(host.hooks('push')[0][1])).toContain('(external)');
  });
});
