import type { SqliteDatabase } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { SYSTEM_ADDRESS } from '../src/address.js';
import { DeliveryEngine } from '../src/engine.js';
import { GATE_TYPES } from '../src/envelope.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';
import { FakeHost } from './fakeHost.js';

// Answer and reply behaviour lives in the kit's host-core vectors; these
// cases pin engine internals and the refusal of non-participants.
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
  engine = new DeliveryEngine({ store, host, gateTypes: GATE_TYPES });
});
afterEach(() => db.close());

describe('answers', () => {
  it('deliverableAddress sends a run that ended to its task', () => {
    expect(engine.deliverableAddress('run:r-000001')).toBe('run:r-000001');
    host.endRun('t-000001');
    expect(engine.deliverableAddress('run:r-000001')).toBe('task:t-000001');
    expect(engine.deliverableAddress('run:r-0000ff')).toBe('run:r-0000ff');
    expect(engine.deliverableAddress('human:wyat')).toBe('human:wyat');
  });

  it('a reply to my own message to a run that ended since is held for its task', async () => {
    const { message: mine } = await engine.send(
      { to: ['run:r-000001'], kind: 'message', body: 'try the cart first' },
      human
    );
    host.endRun('t-000001');
    const { message: r, deliveries } = await engine.send(
      {
        to: ['run:r-000001'],
        kind: 'message',
        body: 'still there?',
        replyTo: mine.id,
      },
      human
    );
    expect(r.to).toEqual(['task:t-000001']);
    expect(deliveries).toEqual([
      expect.objectContaining({
        recipient: 'task:t-000001',
        runId: null,
        state: 'held',
      }),
    ]);
  });

  it("a reply to my own message to a run that ended since reaches its task's live successor", async () => {
    const { message: mine } = await engine.send(
      { to: ['run:r-000001'], kind: 'message', body: 'try the cart first' },
      human
    );
    host.endRun('t-000001');
    host.startRun('t-000001', 'r-000002');
    const { message: r, deliveries } = await engine.send(
      {
        to: ['run:r-000001'],
        kind: 'message',
        body: 'still there?',
        replyTo: mine.id,
      },
      human
    );
    expect(r.to).toEqual(['task:t-000001']);
    expect(deliveries).toEqual([
      expect.objectContaining({
        recipient: 'task:t-000001',
        runId: 'r-000002',
        state: 'pushed',
      }),
    ]);
  });

  it('a reply naming an ended run the replied-to message never reached is still refused', async () => {
    host.startRun('t-000002', 'r-000002');
    const { message: mine } = await engine.send(
      { to: ['run:r-000001'], kind: 'message', body: 'try the cart first' },
      human
    );
    host.endRun('t-000002');
    await expect(
      engine.send(
        {
          to: ['run:r-000002'],
          kind: 'message',
          body: 'still there?',
          replyTo: mine.id,
        },
        human
      )
    ).rejects.toMatchObject({ code: 'invalid', field: 'to[0]' });
  });

  it('a throwing markGateApplied does not fail the reply', async () => {
    const originalError = console.error;
    const logged: unknown[] = [];
    console.error = (label: unknown) => logged.push(label);
    try {
      let thrown = false;
      const originalMarkGateApplied = store.markGateApplied.bind(store);
      store.markGateApplied = (questionId, at) => {
        if (!thrown) {
          thrown = true;
          throw new Error('disk full');
        }
        originalMarkGateApplied(questionId, at);
      };
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
      const { message: a } = await engine.reply(
        gate.id,
        { body: '', choice: 'approve' },
        human
      );
      // send() still committed and emitted the answer despite the store failure.
      expect(a.kind).toBe('answer');
      expect(engine.answerOf(gate.id)?.id).toBe(a.id);
      expect(host.hooks('onAnswered')).toEqual([[gate.id, 'approve']]);
      expect(logged).toEqual(['messaging markGateApplied failed']);
      // Not recorded as applied, so recover() replays it.
      expect(await engine.recover()).toMatchObject({ replayed: 1 });
    } finally {
      console.error = originalError;
    }
  });
});

// §4.6 has a non-participant's reply fail exactly like a reply to an absent
// id; until the engine does, these refusals stay here rather than in vectors.
describe('answer authorization', () => {
  it('a bystander run cannot answer a question addressed to a human', async () => {
    host.startRun('t-000002', 'r-000002');
    const { message: q } = await engine.send(
      { to: ['human:wyat'], kind: 'question', body: 'which?' },
      run1
    );
    await expect(
      engine.reply(
        q.id,
        { body: 'mine' },
        { address: 'run:r-000002', canDecide: false }
      )
    ).rejects.toMatchObject({ code: 'forbidden', field: 'replyTo' });
    const { message: a } = await engine.reply(q.id, { body: 'b' }, human);
    expect(engine.answerOf(q.id)?.id).toBe(a.id);
  });

  it('a run of a different task still gets forbidden', async () => {
    host.startRun('t-000003', 'r-000003');
    const { message: q } = await engine.send(
      { to: ['run:r-000003'], kind: 'question', body: 'which?' },
      human
    );
    host.startRun('t-000009', 'r-000009');
    await expect(
      engine.reply(
        q.id,
        { body: 'not mine' },
        { address: 'run:r-000009', canDecide: false }
      )
    ).rejects.toMatchObject({ code: 'forbidden', field: 'replyTo' });
  });
});

describe('reply authorization (every kind, not just answers)', () => {
  it('a run on an unrelated task cannot reply into a message thread', async () => {
    const { message: m } = await engine.send(
      { to: ['human:wyat'], kind: 'message', body: 'hello' },
      run1
    );
    host.startRun('t-999999', 'r-999999');
    await expect(
      engine.reply(
        m.id,
        { body: 'butting in' },
        { address: 'run:r-999999', canDecide: false }
      )
    ).rejects.toMatchObject({ code: 'forbidden', field: 'replyTo' });
  });
});

describe('replies from non-participants', () => {
  const stranger = { address: 'run:r-000009', canDecide: false };
  const forbidden = {
    code: 'forbidden',
    field: 'replyTo',
    message: 'only a participant can reply in this thread',
  };
  beforeEach(() => host.startRun('t-000009', 'r-000009'));

  it('are refused before the target kind is checked', async () => {
    const { message: notice } = await engine.send(
      { to: ['human:wyat'], kind: 'notice', body: 'fyi' },
      run1
    );
    await expect(
      engine.send(
        { to: ['run:r-000001'], kind: 'answer', body: 'x', replyTo: notice.id },
        stranger
      )
    ).rejects.toMatchObject(forbidden);
  });

  it('are refused before the target choices are checked', async () => {
    const { message: q } = await engine.send(
      {
        to: ['human:wyat'],
        kind: 'question',
        body: 'which?',
        choices: ['a', 'b'],
      },
      run1
    );
    await expect(
      engine.send(
        {
          to: ['run:r-000001'],
          kind: 'answer',
          body: 'x',
          choice: 'zzz',
          replyTo: q.id,
        },
        stranger
      )
    ).rejects.toMatchObject(forbidden);
  });

  it('are refused before the target is checked for a gate', async () => {
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
      engine.send(
        {
          to: [SYSTEM_ADDRESS],
          kind: 'answer',
          body: '',
          choice: 'approve',
          replyTo: gate.id,
        },
        stranger
      )
    ).rejects.toMatchObject(forbidden);
  });
});
