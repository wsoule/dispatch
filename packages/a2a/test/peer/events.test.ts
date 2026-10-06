import type { Message } from '@dispatch-foo/protocol';
import { gateOf } from '@dispatch-foo/protocol';
import { describe, expect, it } from 'bun:test';

import {
  mapPeerEvent,
  peerEventFromMessage,
  peerEventFromTask,
  peerEventKey,
} from '../../src/peer/events.js';
import type { PeerEvent, PeerEventContext } from '../../src/peer/events.js';
import { ENVELOPE_URI } from '../../src/uris.js';
import type { MessageJson, TaskJson } from '../../src/wire.js';

const NOW = new Date('2026-09-25T10:00:00.000Z');
const question: Message = {
  id: 'm-q',
  thread: 'm-q',
  replyTo: null,
  from: 'run:r-000001',
  to: ['a2a:acme'],
  kind: 'question',
  body: 'Which colour?',
  refs: [],
  choices: ['blue', 'red'],
  urgent: false,
  blocking: true,
  wake: 'none',
  createdAt: NOW.toISOString(),
};
const ctx = (over: Partial<PeerEventContext> = {}): PeerEventContext => ({
  alias: 'acme',
  original: question,
  via: 'direct',
  originalAnswered: false,
  lastWorkingNoticeAt: null,
  now: NOW,
  ...over,
});
function statusMessage(state: string, text: string): MessageJson {
  return { messageId: `pm-${state}`, role: 'ROLE_AGENT', parts: [{ text }] };
}
function task(
  state: string,
  text?: string,
  over: Partial<TaskJson> = {}
): TaskJson {
  return {
    id: 'peer-task-1',
    contextId: 'peer-ctx-1',
    status: {
      state: state as TaskJson['status']['state'],
      ...(text === undefined ? {} : { message: statusMessage(state, text) }),
    },
    ...over,
  };
}
const event = (t: TaskJson) => peerEventFromTask(t) as PeerEvent;

describe('peerEventKey', () => {
  it('fits 88 bytes whatever the peer’s ids, and separates states and messages', () => {
    const huge = 'x'.repeat(10 * 1024);
    const key = peerEventKey(
      'a'.repeat(40),
      event(
        task('TASK_STATE_WORKING', 'w', {
          id: huge,
          status: {
            state: 'TASK_STATE_WORKING',
            message: { messageId: huge, role: 'ROLE_AGENT', parts: [] },
          },
        })
      )
    );
    expect(new TextEncoder().encode(key).byteLength).toBeLessThanOrEqual(88);
    expect(key.startsWith(`a2a:${'a'.repeat(40)}:`)).toBe(true);
    expect(
      peerEventKey('acme', event(task('TASK_STATE_WORKING', 'one')))
    ).not.toBe(
      peerEventKey('acme', event(task('TASK_STATE_COMPLETED', 'one')))
    );
  });

  it('is stable for a state with no status message and no timestamp', () => {
    expect(peerEventKey('acme', event(task('TASK_STATE_WORKING')))).toBe(
      peerEventKey('acme', event(task('TASK_STATE_WORKING')))
    );
  });
});

describe('reading untrusted peer shapes', () => {
  it('reads an unknown or missing state as no event', () => {
    expect(peerEventFromTask(task('TASK_STATE_UNSPECIFIED'))).toBeNull();
    expect(peerEventFromTask(task('TASK_STATE_BOGUS'))).toBeNull();
    expect(
      peerEventFromTask({ id: 't', contextId: 'c' } as unknown as TaskJson)
    ).toBeNull();
  });

  it('skips parts and artifacts that are not the shapes it expects', () => {
    const t = {
      ...task('TASK_STATE_COMPLETED'),
      status: {
        state: 'TASK_STATE_COMPLETED',
        message: { messageId: 'pm', role: 'ROLE_AGENT', parts: 'nope' },
      },
      artifacts: [
        null,
        { artifactId: 'a', parts: [{ text: 7 }, { text: 'kept' }] },
      ],
    } as unknown as TaskJson;
    const e = peerEventFromTask(t);
    expect(e).toMatchObject({
      kind: 'task',
      status: { body: '' },
      artifacts: [{ body: 'kept' }],
    });
  });
});

describe('peer parts as text', () => {
  const statusWith = (parts: object[]) =>
    peerEventFromTask(
      task('TASK_STATE_COMPLETED', undefined, {
        status: {
          state: 'TASK_STATE_COMPLETED',
          message: {
            messageId: 'pm',
            role: 'ROLE_AGENT',
            parts: parts as MessageJson['parts'],
          },
        },
      })
    );

  it('links only http(s) urls, at most 20 of them, none over 2048 bytes', () => {
    const e = statusWith([
      { url: 'javascript:alert(1)' },
      { url: 'data:text/html,x' },
      { url: `https://example.com/${'a'.repeat(2100)}` },
      ...Array.from({ length: 25 }, (_, i) => ({
        url: `https://example.com/${i}`,
      })),
    ]);
    const links = e?.kind === 'task' ? (e.status?.links ?? []) : [];
    expect(links).toHaveLength(20);
    expect(links.join('\n')).not.toContain('javascript:');
    expect(links.join('\n')).not.toContain('data:');
    expect(links[0]).toBe('[https://example.com/0](https://example.com/0)');
  });

  it('reads only plain and markdown text parts', () => {
    const e = statusWith([
      { text: 'kept' },
      { text: 'also kept', mediaType: 'text/markdown' },
      { text: '<script>x</script>', mediaType: 'text/html' },
      { text: 'AAAA', mediaType: 'application/octet-stream' },
    ]);
    expect(e?.kind === 'task' ? e.status?.body : null).toBe(
      'kept\n\nalso kept'
    );
  });
});

describe('mapPeerEvent (spec:1498-1506)', () => {
  it('answers a direct question on COMPLETED, matching a choice', () => {
    const [act] = mapPeerEvent(
      event(task('TASK_STATE_COMPLETED', ' Blue ')),
      ctx()
    );
    expect(act).toMatchObject({
      kind: 'send',
      input: {
        kind: 'answer',
        to: ['run:r-000001'],
        replyTo: 'm-q',
        body: 'Blue',
        choice: 'blue',
      },
    });
    expect(
      (act as { input: { idempotencyKey: string } }).input.idempotencyKey
    ).toMatch(/^a2a:acme:/);
  });

  it('answers a direct question from a direct Message response', () => {
    const msg = peerEventFromMessage({
      messageId: 'pm-1',
      role: 'ROLE_AGENT',
      parts: [{ text: 'red' }],
    });
    expect(mapPeerEvent(msg, ctx())).toMatchObject([
      { kind: 'send', input: { kind: 'answer', choice: 'red' } },
    ]);
  });

  it('records a channel question’s reply as a message, never an answer', () => {
    expect(
      mapPeerEvent(
        event(task('TASK_STATE_COMPLETED', 'blue')),
        ctx({ via: 'channel' })
      )
    ).toMatchObject([{ kind: 'send', input: { kind: 'message' } }]);
  });

  it('turns INPUT_REQUIRED into the peer’s own blocking question with cleaned choices', () => {
    const choices = [
      ' yes ',
      'yes',
      'no\nway',
      ...Array.from({ length: 25 }, (_, i) => `c${i}`),
    ];
    const status = statusMessage('TASK_STATE_INPUT_REQUIRED', 'Which region?');
    status.metadata = { [ENVELOPE_URI]: { choices } };
    const t = task('TASK_STATE_INPUT_REQUIRED', undefined, {
      status: { state: 'TASK_STATE_INPUT_REQUIRED', message: status },
    });
    const [act] = mapPeerEvent(event(t), ctx());
    expect(act).toMatchObject({
      kind: 'send',
      input: {
        kind: 'question',
        blocking: true,
        replyTo: 'm-q',
        to: ['run:r-000001'],
        body: 'Which region?',
      },
    });
    const sent = (act as { input: { choices: string[] } }).input.choices;
    expect(sent.slice(0, 2)).toEqual(['yes', 'no way']);
    expect(sent).toHaveLength(20);
  });

  it('notices AUTH_REQUIRED and throttles WORKING notices to one a minute', () => {
    expect(
      mapPeerEvent(event(task('TASK_STATE_AUTH_REQUIRED', 'approve me')), ctx())
    ).toMatchObject([
      {
        kind: 'send',
        input: {
          kind: 'notice',
          body: expect.stringContaining(
            'a2a:acme is waiting on its own authorization'
          ),
        },
      },
    ]);
    expect(
      mapPeerEvent(event(task('TASK_STATE_WORKING', 'halfway')), ctx())
    ).toMatchObject([
      { kind: 'send', input: { kind: 'notice', body: 'halfway' } },
    ]);
    expect(
      mapPeerEvent(
        event(task('TASK_STATE_WORKING', 'still')),
        ctx({ lastWorkingNoticeAt: '2026-09-25T09:59:30.000Z' })
      )
    ).toEqual([]);
    expect(mapPeerEvent(event(task('TASK_STATE_SUBMITTED')), ctx())).toEqual(
      []
    );
  });

  it('closes a direct question with a fixed reason on FAILED, REJECTED or CANCELED, the peer’s words in its own notice', () => {
    expect(
      mapPeerEvent(event(task('TASK_STATE_REJECTED', 'not my job')), ctx())
    ).toMatchObject([
      { kind: 'close', reason: 'a2a:acme declined (REJECTED)' },
      { kind: 'send', input: { kind: 'notice', body: 'not my job' } },
    ]);
    expect(
      mapPeerEvent(event(task('TASK_STATE_FAILED')), ctx({ via: 'channel' }))
    ).toMatchObject([{ kind: 'send', input: { kind: 'notice' } }]);
  });

  it('never lets a peer author a handoff’s answer: the system closes it on the first decisive state', () => {
    const handoff = {
      ...question,
      kind: 'handoff' as const,
      choices: ['accept', 'decline'],
    };
    expect(
      mapPeerEvent(
        event(task('TASK_STATE_WORKING')),
        ctx({ original: handoff })
      )
    ).toEqual([{ kind: 'close', reason: 'a2a:acme accepted (WORKING)' }]);
    expect(
      mapPeerEvent(
        event(task('TASK_STATE_COMPLETED', 'done')),
        ctx({ original: handoff, originalAnswered: true })
      )
    ).toMatchObject([
      { kind: 'send', input: { kind: 'notice', body: 'done' } },
    ]);
    expect(
      mapPeerEvent(
        event(task('TASK_STATE_REJECTED')),
        ctx({ original: handoff })
      )
    ).toEqual([{ kind: 'close', reason: 'a2a:acme declined (REJECTED)' }]);
  });

  it('wraps a gate-shaped data part and cuts an over-64-KiB body', () => {
    const status = statusMessage('TASK_STATE_COMPLETED', 'é'.repeat(40_000));
    status.parts.push({ data: { type: 'tool-approval', requestId: 'r' } });
    const t = task('TASK_STATE_COMPLETED', undefined, {
      status: { state: 'TASK_STATE_COMPLETED', message: status },
    });
    const [act] = mapPeerEvent(event(t), ctx());
    const input = (act as { input: { body: string; data: unknown } }).input;
    expect(gateOf({ data: input.data as never })).toBeNull();
    expect(input.body.endsWith('[… truncated by Dispatch]')).toBe(true);
  });

  it('says an answer once when the status and an artifact both carry it', () => {
    const t = task('TASK_STATE_COMPLETED', 'Blue', {
      artifacts: [{ artifactId: 'answer', parts: [{ text: 'Blue' }] }],
    });
    expect(mapPeerEvent(event(t), ctx())).toMatchObject([
      { kind: 'send', input: { kind: 'answer', body: 'Blue', choice: 'blue' } },
    ]);
  });

  it('keeps an AUTH_REQUIRED notice within 64 KiB, prefix included', () => {
    const [act] = mapPeerEvent(
      event(task('TASK_STATE_AUTH_REQUIRED', 'a'.repeat(70_000))),
      ctx()
    );
    const body = (act as { input: { body: string } }).input.body;
    expect(
      body.startsWith('a2a:acme is waiting on its own authorization')
    ).toBe(true);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(
      64 * 1024
    );
  });

  it('never asks to wake anyone, so a peer cannot start a run', () => {
    for (const state of [
      'TASK_STATE_COMPLETED',
      'TASK_STATE_WORKING',
      'TASK_STATE_INPUT_REQUIRED',
      'TASK_STATE_AUTH_REQUIRED',
      'TASK_STATE_FAILED',
    ])
      for (const via of ['direct', 'channel'] as const)
        for (const act of mapPeerEvent(
          event(task(state, 'text')),
          ctx({ via })
        ))
          if (act.kind === 'send') expect(act.input.wake).toBeUndefined();
  });

  it('never puts the peer’s text in a close reason, which the system authors', () => {
    const [act] = mapPeerEvent(
      event(
        task('TASK_STATE_FAILED', '![x](https://evil.example/p.png) **click**')
      ),
      ctx()
    );
    expect(act).toEqual({ kind: 'close', reason: 'a2a:acme failed (FAILED)' });
  });
});
