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

  it('reply holds the answer on an ended run that stands for no task', async () => {
    host.auxRuns.add('r-0000a1');
    const reviewer = { address: 'run:r-0000a1', canDecide: false };
    const { message: q } = await engine.send(
      {
        to: ['human:wyat'],
        kind: 'question',
        body: 'ship it?',
        blocking: true,
      },
      reviewer
    );
    host.auxRuns.delete('r-0000a1');
    const { message: a, deliveries } = await engine.reply(
      q.id,
      { body: 'yes' },
      human
    );
    expect(a.to).toEqual(['run:r-0000a1']);
    expect(deliveries).toEqual([
      expect.objectContaining({
        recipient: 'run:r-0000a1',
        runId: null,
        state: 'held',
      }),
    ]);
    expect(engine.openBlocking()).toEqual([]);
    await expect(
      engine.send({ to: ['run:r-0000a1'], kind: 'message', body: 'x' }, human)
    ).rejects.toMatchObject({ code: 'invalid', field: 'to[0]' });
  });

  it('deliverableAddress sends a run that ended to its task', () => {
    expect(engine.deliverableAddress('run:r-000001')).toBe('run:r-000001');
    host.endRun('t-000001');
    expect(engine.deliverableAddress('run:r-000001')).toBe('task:t-000001');
    expect(engine.deliverableAddress('run:r-0000ff')).toBe('run:r-0000ff');
    expect(engine.deliverableAddress('human:wyat')).toBe('human:wyat');
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

  it('a second answer is a conflict', async () => {
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
    await engine.reply(q.id, { body: '', choice: 'a' }, human);
    await expect(
      engine.reply(q.id, { body: '', choice: 'b' }, human)
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('reply after close is a conflict', async () => {
    const { message: gate } = await engine.send(
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
    engine.close(gate.id, 'no longer needed');
    await expect(
      engine.reply(gate.id, { body: '', choice: 'grant' }, human)
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(host.hooks('onAnswered')).toEqual([]);
  });

  it('a throwing onAnswered does not fail the reply', async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      host.failOnAnswered = true;
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
      expect(a.kind).toBe('answer');
      expect(engine.answerOf(gate.id)?.id).toBe(a.id);
    } finally {
      console.error = originalError;
    }
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

  it('reply to a system gate stores the answer with no deliveries', async () => {
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
    const result = await engine.reply(
      gate.id,
      { body: '', choice: 'approve' },
      human
    );
    expect(result.deliveries).toEqual([]);
  });
});

describe('close', () => {
  it('throws not-found for an unknown id', () => {
    expect(() => engine.close('m-doesnotexist', 'reason')).toThrow(
      expect.objectContaining({ code: 'not-found' })
    );
  });

  it('throws conflict when the question is already answered', async () => {
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
    await engine.reply(q.id, { body: '', choice: 'a' }, human);
    expect(() => engine.close(q.id, 'too late')).toThrow(
      expect.objectContaining({ code: 'conflict' })
    );
  });

  it('throws invalid for a message that is not a question or handoff', async () => {
    const { message: m } = await engine.send(
      { to: ['human:wyat'], kind: 'notice', body: 'fyi' },
      run1
    );
    expect(() => engine.close(m.id, 'n/a')).toThrow(
      expect.objectContaining({ code: 'invalid', field: 'replyTo' })
    );
  });

  it('marks the question deliveries answered', async () => {
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
    engine.close(q.id, 'done');
    expect(store.deliveries({ messageId: q.id }).map((d) => d.state)).toEqual([
      'answered',
    ]);
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

  it('the run of an addressed task can answer', async () => {
    host.startRun('t-000002', 'r-000002');
    const { message: q } = await engine.send(
      { to: ['task:t-000002'], kind: 'question', body: 'which?' },
      human
    );
    const { message: a } = await engine.reply(
      q.id,
      { body: 'this one' },
      { address: 'run:r-000002', canDecide: false }
    );
    expect(engine.answerOf(q.id)?.id).toBe(a.id);
  });

  it('a deciding human can answer a question sent to another human', async () => {
    const { message: q } = await engine.send(
      { to: ['human:wyat'], kind: 'question', body: 'which?' },
      run1
    );
    const { message: a } = await engine.reply(
      q.id,
      { body: 'b' },
      { address: 'human:ana', canDecide: true }
    );
    expect(engine.answerOf(q.id)?.id).toBe(a.id);
  });

  it('a run the question was redelivered to (after a failed push) can answer', async () => {
    host.startRun('t-000003', 'r-000003');
    host.failPushFor.add('r-000003');
    const { message: q, deliveries } = await engine.send(
      { to: ['run:r-000003'], kind: 'question', body: 'which?' },
      human
    );
    expect(deliveries[0]).toMatchObject({ state: 'held', runId: null });
    host.endRun('t-000003');
    host.startRun('t-000003', 'r-000004');
    await engine.deliverHeld('r-000004', 't-000003');
    const { message: a } = await engine.reply(
      q.id,
      { body: 'mine' },
      { address: 'run:r-000004', canDecide: false }
    );
    expect(engine.answerOf(q.id)?.id).toBe(a.id);
  });

  it('a successor run of the same task can answer a question its predecessor was ending', async () => {
    host.startRun('t-000003', 'r-000003');
    const { message: q } = await engine.send(
      { to: ['run:r-000003'], kind: 'question', body: 'which?' },
      human
    );
    host.endRun('t-000003');
    host.startRun('t-000003', 'r-000005');
    const { message: a } = await engine.reply(
      q.id,
      { body: 'mine' },
      { address: 'run:r-000005', canDecide: false }
    );
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

// The participant rule from 'answer authorization' above, applied to plain
// messages: a non-participant cannot reply into (and so read) any thread.
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

  it('the original sender can reply into their own thread', async () => {
    const { message: m } = await engine.send(
      { to: ['human:wyat'], kind: 'message', body: 'hello' },
      run1
    );
    const { message: r } = await engine.reply(
      m.id,
      { body: 'following up' },
      run1
    );
    expect(r.replyTo).toBe(m.id);
  });

  it('a recipient can reply', async () => {
    const { message: m } = await engine.send(
      { to: ['human:wyat'], kind: 'message', body: 'hello' },
      run1
    );
    const { message: r } = await engine.reply(m.id, { body: 'got it' }, human);
    expect(r.replyTo).toBe(m.id);
  });

  it("the addressed task's run can reply", async () => {
    host.startRun('t-000002', 'r-000002');
    const { message: m } = await engine.send(
      { to: ['task:t-000002'], kind: 'message', body: 'hello' },
      human
    );
    const { message: r } = await engine.reply(
      m.id,
      { body: 'on it' },
      { address: 'run:r-000002', canDecide: false }
    );
    expect(r.replyTo).toBe(m.id);
  });

  it('a successor run of the same task can reply', async () => {
    host.startRun('t-000003', 'r-000003');
    const { message: m } = await engine.send(
      { to: ['run:r-000003'], kind: 'message', body: 'hello' },
      human
    );
    host.endRun('t-000003');
    host.startRun('t-000003', 'r-000005');
    const { message: r } = await engine.reply(
      m.id,
      { body: 'taking over' },
      { address: 'run:r-000005', canDecide: false }
    );
    expect(r.replyTo).toBe(m.id);
  });

  it("a later run of the same task can reply into its predecessor's message", async () => {
    host.startRun('t-000003', 'r-000003');
    const { message: m } = await engine.send(
      { to: ['human:wyat'], kind: 'message', body: 'started the migration' },
      { address: 'run:r-000003', canDecide: false }
    );
    host.endRun('t-000003');
    host.startRun('t-000003', 'r-000005');
    const { message: r } = await engine.reply(
      m.id,
      { body: 'migration finished' },
      { address: 'run:r-000005', canDecide: false }
    );
    expect(r.replyTo).toBe(m.id);
  });

  it('a deciding human can reply into any thread', async () => {
    const { message: m } = await engine.send(
      { to: ['human:wyat'], kind: 'message', body: 'hello' },
      run1
    );
    const { message: r } = await engine.reply(
      m.id,
      { body: 'stepping in' },
      { address: 'human:ana', canDecide: true }
    );
    expect(r.replyTo).toBe(m.id);
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

describe('gate-effect ordering', () => {
  it('emits the answer only after onAnswered ran', async () => {
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
    engine.subscribe((e) => {
      if (e.type === 'message' && e.message.kind === 'answer')
        host.calls.push({ hook: 'answer-event', args: [e.message.id] });
    });
    await engine.reply(gate.id, { body: '', choice: 'approve' }, human);
    const order = host.calls
      .map((c) => c.hook)
      .filter((h) => h === 'onAnswered' || h === 'answer-event');
    expect(order).toEqual(['onAnswered', 'answer-event']);
  });
});
