import type { OpenInput } from '@dispatch/a2a';
import { decideState } from '@dispatch/a2a';
import { MessagingError, SYSTEM_ADDRESS } from '@dispatch/protocol';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { reconcileA2A } from '../../src/a2a/reconcile.js';
import { HUMAN, useTempProject, waitFor } from '../messaging/harness.js';
import { bridgeFixture } from './fixture.js';

const project = useTempProject();
let f: Awaited<ReturnType<typeof bridgeFixture>>;
beforeEach(async () => {
  f = await bridgeFixture(project.root());
});
afterEach(() => f.close());

const SYSTEM = { address: SYSTEM_ADDRESS, canDecide: true };
const ALICE = { address: 'human:alice', canDecide: true };
const ask = (over: Partial<OpenInput> = {}): OpenInput => ({
  clientMessageId: 'c-1',
  contextId: null,
  kind: 'ask',
  to: null,
  replyTo: null,
  body: 'Is /sessions final?',
  refs: [],
  ...over,
});
async function open(over: Partial<OpenInput> = {}): Promise<string> {
  const opened = await f.port.open(f.caller, ask(over));
  if (opened.kind !== 'task') throw new Error('expected a task');
  return opened.taskId;
}
async function state(taskId: string) {
  const facts = await f.port.facts(f.caller, taskId);
  return facts === null ? null : decideState(facts).state;
}

describe('ask', () => {
  it('sends a blocking question to the owner as the client and records the task', async () => {
    const id = await open();
    expect(f.messaging.engine.getMessage(id)).toMatchObject({
      from: f.caller.address,
      to: ['human:wyat'],
      kind: 'question',
      blocking: true,
    });
    expect(f.store.getTask(id)).toMatchObject({
      skill: 'ask',
      client: f.caller.address,
      contextId: id,
    });
    expect(await state(id)).toBe('WORKING');
  });

  it('replays the same messageId as the same task, even after a limit would refuse it', async () => {
    const id = await open();
    const base = f.deps.policy();
    f.deps.policy = () => ({ ...base, openTasksPerClient: 1 });
    expect(await open()).toBe(id);
    await expect(open({ clientMessageId: 'c-2' })).rejects.toMatchObject({
      code: 'limited',
    });
  });

  it('completes when the owner answers, and fires watchers', async () => {
    const id = await open();
    let fired = 0;
    const stop = f.port.watch(f.caller, id, () => {
      fired += 1;
    });
    await f.messaging.engine.reply(id, { body: 'Yes, final.' }, HUMAN);
    await waitFor(() => fired > 0);
    stop();
    expect(await state(id)).toBe('COMPLETED');
    expect(f.store.getTask(id)?.state).toBe('COMPLETED');
  });

  it('keeps a teammate’s reply to the owner out of the client’s scope', async () => {
    const id = await open();
    await f.messaging.engine.send(
      {
        to: ['human:wyat'],
        kind: 'message',
        replyTo: id,
        body: 'internal note',
      },
      ALICE
    );
    const facts = await f.port.facts(f.caller, id);
    expect(facts?.scope.map((m) => m.body)).not.toContain('internal note');
  });

  it('round-trips a human’s blocking question as INPUT_REQUIRED and re-asks on a non-choice', async () => {
    const id = await open();
    const { message: q } = await f.messaging.engine.send(
      {
        to: [f.caller.address],
        kind: 'question',
        blocking: true,
        replyTo: id,
        body: 'Which region?',
        choices: ['us', 'eu'],
      },
      HUMAN
    );
    expect(await state(id)).toBe('INPUT_REQUIRED');
    expect(
      await f.port.continue(f.caller, {
        clientMessageId: 'c-2',
        taskId: id,
        contextId: null,
        body: 'mars',
        refs: [],
      })
    ).toEqual({ reask: 'Answer with one of: us | eu' });
    expect(f.messaging.engine.answerOf(q.id)).toBeNull();
    await f.port.continue(f.caller, {
      clientMessageId: 'c-3',
      taskId: id,
      contextId: null,
      body: ' EU ',
      refs: [],
    });
    expect(f.messaging.engine.answerOf(q.id)).toMatchObject({
      choice: 'eu',
      from: f.caller.address,
    });
    const before = f.messaging.engine.thread(id).messages.length;
    await f.port.continue(f.caller, {
      clientMessageId: 'c-3',
      taskId: id,
      contextId: null,
      body: ' EU ',
      refs: [],
    });
    expect(f.messaging.engine.thread(id).messages.length).toBe(before);
  });

  it('sends a continuation outside INPUT_REQUIRED to the root’s recipients', async () => {
    const id = await open();
    await f.port.continue(f.caller, {
      clientMessageId: 'c-2',
      taskId: id,
      contextId: null,
      body: 'Also: v2?',
      refs: [],
    });
    const last = f.messaging.engine.thread(id).messages.at(-1);
    expect(last).toMatchObject({
      kind: 'message',
      replyTo: id,
      to: ['human:wyat'],
    });
  });

  it('answers an unknown and a foreign contextId with the same error', async () => {
    await expect(open({ contextId: 'm-nope' })).rejects.toMatchObject({
      code: 'invalid',
      field: 'message.contextId',
    });
    const { message: other } = await f.messaging.engine.send(
      { to: ['human:alice'], kind: 'message', body: 'private' },
      HUMAN
    );
    await expect(
      open({ clientMessageId: 'c-2', contextId: other.thread })
    ).rejects.toMatchObject({ code: 'invalid', field: 'message.contextId' });
  });

  it('refuses a recipient off the client’s list', async () => {
    await expect(open({ to: ['human:alice'] })).rejects.toMatchObject({
      code: 'forbidden',
      field: 'to[0]',
    });
    const listed = f.addClient('planner', ['human:alice']);
    const opened = await f.port.open(listed, ask({ to: ['human:alice'] }));
    expect(opened.kind).toBe('task');
  });

  // A reply with no `to` goes to the replied-to message's sender.
  it('addresses a reply with no to to the replied-to message’s sender, not the owner', async () => {
    const id = await open();
    const { message: fromAlice } = await f.messaging.engine.send(
      {
        to: [f.caller.address],
        kind: 'message',
        replyTo: id,
        body: 'Which environment?',
      },
      ALICE
    );
    const opened = await f.port.open(
      f.caller,
      ask({
        clientMessageId: 'c-2',
        kind: 'message',
        replyTo: fromAlice.id,
        body: 'staging',
      })
    );
    expect(opened.kind).toBe('reply');
    expect(f.messaging.engine.thread(id).messages.at(-1)).toMatchObject({
      from: f.caller.address,
      to: ['human:alice'],
      replyTo: fromAlice.id,
    });
  });

  it('refuses a client replying to a gate it cannot see', async () => {
    const id = await open();
    const { message: gate } = await f.messaging.engine.send(
      {
        to: ['human:wyat'],
        kind: 'question',
        blocking: true,
        choices: ['approve', 'deny'],
        replyTo: id,
        body: 'wake?',
        data: { type: 'wake', target: 'task:t-000001', message: id },
      },
      SYSTEM
    );
    await expect(
      open({ clientMessageId: 'c-9', kind: 'message', replyTo: gate.id })
    ).rejects.toMatchObject({ code: 'not-found', field: 'replyTo' });
  });

  it('fails an unanswered ask when its task is dropped, but keeps an answered one completed', async () => {
    const task = f.tasks.create({ title: 'Asked of' });
    const asClient = { address: f.caller.address, canDecide: false };
    const askTask = (key: string) =>
      f.messaging.engine.send(
        {
          to: [`task:${task.meta.id}`],
          kind: 'question',
          blocking: true,
          body: 'Is it done?',
          idempotencyKey: key,
        },
        asClient
      );
    const { message: answered } = await askTask('c-1');
    const { message: open } = await askTask('c-2');
    reconcileA2A(f.deps, f.watch);
    await f.messaging.engine.reply(answered.id, { body: 'Yes.' }, HUMAN);
    f.tasks.update(task.meta.id, { status: 'dropped' });
    expect(await state(answered.id)).toBe('COMPLETED');
    expect(await state(open.id)).toBe('FAILED');
  });

  it('keeps an ask failed when its task is dropped before the answer', async () => {
    const task = f.tasks.create({ title: 'Asked of' });
    const { message } = await f.messaging.engine.send(
      {
        to: [`task:${task.meta.id}`],
        kind: 'question',
        blocking: true,
        body: 'Is it done?',
        idempotencyKey: 'c-late',
      },
      { address: f.caller.address, canDecide: false }
    );
    reconcileA2A(f.deps, f.watch);
    f.tasks.update(task.meta.id, { status: 'dropped' });
    f.watch.recompute(message.id);
    expect(f.store.getTask(message.id)?.state).toBe('FAILED');
    await f.messaging.engine.reply(message.id, { body: 'Late yes.' }, HUMAN);
    f.watch.recompute(message.id);
    const facts = await f.port.facts(f.caller, message.id);
    if (facts === null) throw new Error('expected facts');
    expect(decideState(facts)).toMatchObject({
      state: 'FAILED',
      status: { text: 'The task this was asked of was dropped.' },
    });
    expect(f.store.getTask(message.id)?.state).toBe('FAILED');
  });

  it('refuses mail to a client outside its tasks', async () => {
    await expect(
      f.messaging.engine.send(
        { to: [f.caller.address], kind: 'message', body: 'cold call' },
        HUMAN
      )
    ).rejects.toMatchObject({ code: 'invalid', field: 'to[0]' });
  });
});

describe('watch', () => {
  it('keeps recomputing other tasks when one cannot be read', async () => {
    const id = await open();
    const row = f.store.getTask(id);
    if (row === null) throw new Error('expected a row');
    const orphan = 'm-00000000000000000000000000';
    f.store.insertTask({ ...row, id: orphan });
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await f.messaging.engine.reply(id, { body: 'Yes.' }, HUMAN);
      await waitFor(() => f.store.getTask(id)?.state === 'COMPLETED');
      expect(logged).toHaveBeenCalledWith(
        `a2a: could not recompute task ${orphan}`,
        expect.any(Error)
      );
    } finally {
      logged.mockRestore();
    }
  });

  it('checks refs past a task that cannot be read', async () => {
    const id = await open();
    const row = f.store.getTask(id);
    if (row === null) throw new Error('expected a row');
    f.store.insertTask({ ...row, id: 'm-00000000000000000000000000' });
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await f.port.continue(f.caller, {
        taskId: id,
        contextId: null,
        clientMessageId: 'c-refs',
        body: 'See the question.',
        refs: [{ type: 'message', id }],
      });
    } finally {
      logged.mockRestore();
    }
  });
});

describe('plain messages', () => {
  it('delivers a notice and returns a direct reply, with no task', async () => {
    const opened = await f.port.open(
      f.caller,
      ask({ kind: 'notice', body: 'FYI: v2 ships Friday' })
    );
    expect(opened).toMatchObject({
      kind: 'reply',
      text: expect.stringContaining('Delivered to human:wyat'),
    });
    expect(f.store.tasksOf(f.caller.address)).toHaveLength(0);
  });
});

describe('cancel', () => {
  it('closes an unanswered ask as CANCELED, is idempotent, and refuses a finished one', async () => {
    const id = await open();
    await f.port.cancel(f.caller, id);
    await f.port.cancel(f.caller, id);
    expect(await state(id)).toBe('CANCELED');
    const done = await open({ clientMessageId: 'c-2' });
    await f.messaging.engine.reply(done, { body: 'done' }, HUMAN);
    await expect(f.port.cancel(f.caller, done)).rejects.toMatchObject({
      reason: 'TASK_NOT_CANCELABLE',
    });
  });

  it('records the cancel before closing the gate, and undoes it when an answer wins', async () => {
    const id = await open();
    const engine = f.messaging.engine;
    const close = engine.close.bind(engine);
    const atClose: (string | null | undefined)[] = [];
    const spy = spyOn(engine, 'close').mockImplementation((qid, reason) => {
      atClose.push(f.store.getTask(id)?.canceledAt);
      return close(qid, reason);
    });
    try {
      await f.port.cancel(f.caller, id);
      expect(atClose[0]).toEqual(expect.any(String));
      const raced = await open({ clientMessageId: 'c-2' });
      spy.mockImplementation(() => {
        throw new MessagingError('conflict', 'already answered');
      });
      await expect(f.port.cancel(f.caller, raced)).rejects.toMatchObject({
        reason: 'TASK_NOT_CANCELABLE',
      });
      expect(f.store.getTask(raced)?.canceledAt).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('ownership, listing and limits', () => {
  it('hides another client’s task', async () => {
    const id = await open();
    const other = f.addClient('other');
    expect(await f.port.facts(other, id)).toBeNull();
    await expect(f.port.cancel(other, id)).rejects.toMatchObject({
      code: 'not-found',
      field: 'taskId',
    });
  });

  it('lists the caller’s tasks with a next page token', async () => {
    for (const n of [1, 2, 3]) await open({ clientMessageId: `c-${n}` });
    const first = await f.port.list(f.caller, { pageSize: 2 });
    expect(first.ids).toHaveLength(2);
    expect(first.totalSize).toBe(3);
    const second = await f.port.list(f.caller, {
      pageSize: 2,
      pageToken: first.nextPageToken,
    });
    expect(second.ids).toHaveLength(1);
    expect(second.nextPageToken).toBe('');
  });

  it('counts sends per hour from messages.db', async () => {
    const base = f.deps.policy();
    f.deps.policy = () => ({ ...base, sendsPerHour: 1 });
    await open();
    await expect(open({ clientMessageId: 'c-2' })).rejects.toMatchObject({
      code: 'limited',
    });
  });

  it('admits requests per minute and streams per client, and a released stream frees its slot', async () => {
    const base = f.deps.policy();
    f.deps.policy = () => ({
      ...base,
      requestsPerMinute: 2,
      streamsPerClient: 1,
    });
    expect((await f.port.admit(f.caller, 'request')).ok).toBe(true);
    expect((await f.port.admit(f.caller, 'request')).ok).toBe(true);
    expect(await f.port.admit(f.caller, 'request')).toMatchObject({
      ok: false,
    });
    const stream = await f.port.admit(f.caller, 'stream');
    expect(await f.port.admit(f.caller, 'stream')).toMatchObject({
      ok: false,
    });
    if (stream.ok) stream.release?.();
    expect((await f.port.admit(f.caller, 'stream')).ok).toBe(true);
  });
});
