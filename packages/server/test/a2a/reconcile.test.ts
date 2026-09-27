import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';

import { reconcileA2A, rowFor } from '../../src/a2a/reconcile.js';
import { HUMAN, useTempProject } from '../messaging/harness.js';
import { bridgeFixture } from './fixture.js';

const project = useTempProject();
let f: Awaited<ReturnType<typeof bridgeFixture>>;
beforeEach(async () => {
  f = await bridgeFixture(project.root());
});
afterEach(() => f.close());

const asClient = () => ({ address: f.caller.address, canDecide: false });

it('writes the row an ask lost to a crash between the engine commit and a2a.db', async () => {
  const { message } = await f.messaging.engine.send(
    {
      to: ['human:wyat'],
      kind: 'question',
      blocking: true,
      body: 'q',
      idempotencyKey: 'c-7',
    },
    asClient()
  );
  expect(reconcileA2A(f.deps, f.watch).created).toBe(1);
  expect(f.store.getTask(message.id)).toMatchObject({ skill: 'ask' });
  expect(reconcileA2A(f.deps, f.watch).created).toBe(0);
});

it('reconciles an ask opened with a contextId (it replies to the thread root)', async () => {
  const first = await f.port.open(f.caller, {
    clientMessageId: 'c-1',
    contextId: null,
    kind: 'ask',
    to: null,
    replyTo: null,
    body: 'q1',
    refs: [],
  });
  if (first.kind !== 'task') throw new Error('expected a task');
  const { message } = await f.messaging.engine.send(
    {
      to: ['human:wyat'],
      kind: 'question',
      blocking: true,
      body: 'q2',
      replyTo: first.taskId,
      idempotencyKey: 'c-8',
    },
    asClient()
  );
  reconcileA2A(f.deps, f.watch);
  expect(f.store.getTask(message.id)).toMatchObject({
    contextId: first.taskId,
  });
});

it('never makes a task of a plain message', async () => {
  await f.messaging.engine.send(
    { to: ['human:wyat'], kind: 'message', body: 'fyi', idempotencyKey: 'c-9' },
    asClient()
  );
  expect(reconcileA2A(f.deps, f.watch).created).toBe(0);
});

it('recomputes the state cache of open tasks', async () => {
  const opened = await f.port.open(f.caller, {
    clientMessageId: 'c-1',
    contextId: null,
    kind: 'ask',
    to: null,
    replyTo: null,
    body: 'q',
    refs: [],
  });
  if (opened.kind !== 'task') throw new Error('expected a task');
  f.store.updateTask(opened.taskId, { state: 'WORKING' });
  await f.messaging.engine.reply(opened.taskId, { body: 'yes' }, HUMAN);
  f.store.updateTask(opened.taskId, { state: 'WORKING' });
  reconcileA2A(f.deps, f.watch);
  expect(f.store.getTask(opened.taskId)?.state).toBe('COMPLETED');
});

it('logs a task that cannot be recomputed and still recomputes the rest', async () => {
  const opened = await f.port.open(f.caller, {
    clientMessageId: 'c-1',
    contextId: null,
    kind: 'ask',
    to: null,
    replyTo: null,
    body: 'q',
    refs: [],
  });
  if (opened.kind !== 'task') throw new Error('expected a task');
  const root = f.messaging.engine.getMessage(opened.taskId);
  if (root === null) throw new Error('no root message');
  for (const id of ['m-0000lost', 'm-9999lost']) {
    f.store.insertTask(rowFor(f.caller.address, { ...root, id, thread: id }));
  }
  await f.messaging.engine.reply(opened.taskId, { body: 'yes' }, HUMAN);
  f.store.updateTask(opened.taskId, { state: 'WORKING' });
  const logged: string[] = [];
  const spy = spyOn(console, 'error').mockImplementation((...args) => {
    logged.push(args.map(String).join(' '));
  });
  try {
    expect(reconcileA2A(f.deps, f.watch).recomputed).toBe(3);
  } finally {
    spy.mockRestore();
  }
  expect(f.store.getTask(opened.taskId)?.state).toBe('COMPLETED');
  expect(logged.join('\n')).toContain('m-0000lost');
});
