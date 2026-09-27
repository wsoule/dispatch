import type { Message } from '@dispatch/protocol';

import type { TaskFacts } from '../src/port.js';

export const CLIENT = 'agent:wyat/a2a.acme';

let seq = 0;
export function msg(over: Partial<Message> = {}): Message {
  seq += 1;
  const id = over.id ?? `m-${String(seq).padStart(4, '0')}`;
  return {
    id,
    thread: 'm-root',
    replyTo: null,
    from: 'human:wyat',
    to: [CLIENT],
    kind: 'message',
    body: `body ${id}`,
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: `2026-09-25T10:${String(seq % 60).padStart(2, '0')}:00.000Z`,
    ...over,
  };
}

export const ROOT = msg({
  id: 'm-root',
  from: CLIENT,
  to: ['human:wyat'],
  kind: 'question',
  blocking: true,
  body: 'Is /sessions final?',
});

export function facts(over: Partial<TaskFacts> = {}): TaskFacts {
  return {
    id: 'm-root',
    contextId: 'm-root',
    skill: 'ask',
    client: CLIENT,
    createdAt: ROOT.createdAt,
    canceledAt: null,
    declinedAt: null,
    root: ROOT,
    scope: [ROOT],
    rootDeliveries: ['notified'],
    answer: null,
    openQuestions: [],
    openGates: [],
    task: null,
    dropped: null,
    recipientTaskDropped: false,
    work: {},
    clientIds: { 'm-root': 'c-1' },
    ...over,
  };
}
