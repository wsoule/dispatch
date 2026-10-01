import type { Message } from '@dispatch/protocol';
import { SYSTEM_ADDRESS } from '@dispatch/protocol';
import { afterEach, beforeEach, expect, it } from 'bun:test';

import { bridgeExternalPolicy } from '../../src/a2a/external.js';
import { HUMAN, useTempProject } from '../messaging/harness.js';
import { bridgeFixture } from './fixture.js';

const project = useTempProject();
let f: Awaited<ReturnType<typeof bridgeFixture>>;
beforeEach(async () => {
  f = await bridgeFixture(project.root());
});
afterEach(() => f.close());

function message(over: Partial<Message>): Message {
  return {
    id: 'm-x',
    thread: 'm-x',
    replyTo: null,
    from: 'human:wyat',
    to: [],
    kind: 'message',
    body: 'body',
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

async function openAsk(): Promise<Message> {
  const opened = await f.port.open(f.caller, {
    clientMessageId: 'c-1',
    contextId: null,
    kind: 'ask',
    to: null,
    replyTo: null,
    body: 'Is /sessions final?',
    refs: [],
  });
  if (opened.kind !== 'task') throw new Error('expected a task');
  const root = f.messaging.engine.getMessage(opened.taskId);
  if (root === null) throw new Error('no root message');
  return root;
}

it('refuses an answer to a gate on data, even inside the client’s task', async () => {
  const root = await openAsk();
  const gate = message({
    id: 'm-gate',
    thread: root.thread,
    replyTo: root.id,
    from: SYSTEM_ADDRESS,
    kind: 'question',
    data: { type: 'future-gate' },
  });
  const answer = message({
    thread: root.thread,
    replyTo: gate.id,
    kind: 'answer',
    to: [f.caller.address],
  });
  const target = {
    recipient: f.caller.address,
    via: 'direct' as const,
    field: 'to[0]',
  };
  const policy = bridgeExternalPolicy(f.deps);
  expect(() => policy.admitExternal(target, HUMAN, gate, answer)).toThrow(
    expect.objectContaining({ code: 'forbidden', field: 'data' })
  );
  expect(policy.admitExternal(target, HUMAN, root, answer)).toBe('deliver');
});

it('refuses every client while a2a.db is down, and delivers to anyone else', () => {
  const policy = bridgeExternalPolicy(null);
  const reply = message({ to: [f.caller.address] });
  expect(() =>
    policy.admitExternal(
      { recipient: f.caller.address, via: 'direct', field: 'to[0]' },
      HUMAN,
      null,
      reply
    )
  ).toThrow('the A2A bridge is unavailable');
  expect(
    policy.admitExternal(
      { recipient: 'human:alice', via: 'direct', field: 'to[0]' },
      HUMAN,
      null,
      reply
    )
  ).toBe('deliver');
  expect(policy.external(f.caller.address)).toBe('client');
  expect(policy.external('human:alice')).toBeNull();
});
