import type { Message } from '@dispatch/protocol';
import { expect, it } from 'bun:test';

import { peerOutboundMessage } from '../../src/peer/message.js';
import { ENVELOPE_URI, WORK_URI } from '../../src/uris.js';

const base: Message = {
  id: 'm-01k',
  thread: 'm-01j',
  replyTo: 'm-01j',
  from: 'run:r-000001',
  to: ['a2a:acme', 'human:alice', 'channel:ops'],
  kind: 'question',
  body: 'Which colour?',
  refs: [{ type: 'commit', id: 'abc123', at: 'src/a.ts:1' }],
  choices: ['blue', 'red'],
  urgent: false,
  blocking: true,
  wake: 'none',
  createdAt: '2026-09-25T10:00:00.000Z',
};

it('names only the peer, keeps its own id as messageId and refs as opaque ids', () => {
  const out = peerOutboundMessage(base, 'acme', {
    contextId: null,
    taskId: null,
  });
  expect(out).toMatchObject({
    messageId: 'm-01k',
    role: 'ROLE_USER',
    parts: [{ text: 'Which colour?', mediaType: 'text/markdown' }],
    extensions: [ENVELOPE_URI],
  });
  expect(out.metadata?.[ENVELOPE_URI]).toEqual({
    from: 'run:r-000001',
    to: ['a2a:acme'],
    kind: 'question',
    replyTo: 'm-01j',
    blocking: true,
    choices: ['blue', 'red'],
    refs: [{ type: 'commit', id: 'abc123' }],
  });
  expect(JSON.stringify(out)).not.toContain('human:alice');
  expect(JSON.stringify(out)).not.toContain('channel:ops');
  expect(JSON.stringify(out)).not.toContain('src/a.ts');
  expect(out).not.toHaveProperty('contextId');
});

it('continues the peer’s context and task, and sends a handoff with the work extension', () => {
  const out = peerOutboundMessage(
    {
      ...base,
      kind: 'handoff',
      body: 'Rate-limit uploads\n\nDetails…',
      choices: undefined,
    },
    'acme',
    { contextId: 'ctx-9', taskId: 'task-9' }
  );
  expect(out).toMatchObject({
    contextId: 'ctx-9',
    taskId: 'task-9',
    extensions: [ENVELOPE_URI, WORK_URI],
  });
  expect(out.metadata?.[WORK_URI]).toEqual({
    skill: 'handoff',
    title: 'Rate-limit uploads',
  });
});

it('cuts a handoff title to 200 bytes without splitting a character', () => {
  const out = peerOutboundMessage(
    { ...base, kind: 'handoff', body: 'é'.repeat(150), choices: undefined },
    'acme',
    { contextId: null, taskId: null }
  );
  const title = (out.metadata?.[WORK_URI] as { title?: string } | undefined)
    ?.title;
  expect(new TextEncoder().encode(title ?? '').byteLength).toBe(200);
  expect(title).toBe('é'.repeat(100));
});

it('says the choice when an answer has no text', () => {
  const answer: Message = {
    ...base,
    kind: 'answer',
    body: '',
    choice: 'eu',
    choices: undefined,
    blocking: false,
  };
  expect(
    peerOutboundMessage(answer, 'acme', {
      contextId: 'ctx-9',
      taskId: 'task-9',
    }).parts
  ).toEqual([{ text: 'eu', mediaType: 'text/markdown' }]);
});

it('sends a custom x- kind as a plain message', () => {
  expect(
    (
      peerOutboundMessage({ ...base, kind: 'x-deploy' }, 'acme', {
        contextId: null,
        taskId: null,
      }).metadata?.[ENVELOPE_URI] as { kind?: string } | undefined
    )?.kind
  ).toBe('message');
});
