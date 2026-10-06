import type { TaskComment } from '@dispatch-foo/core/browser';
import type { Message } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { buildTimeline, quoteOf } from './timeline';

function msg(id: string, at: string, over: Partial<Message> = {}): Message {
  return {
    id,
    thread: id,
    replyTo: null,
    from: 'human:sam',
    to: ['task:t-1'],
    kind: 'message',
    body: `body ${id}`,
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: at,
    ...over,
  } as Message;
}

function comment(id: string, at: string): TaskComment {
  return {
    id,
    taskId: 't-1',
    author: 'human:wyat',
    body: `comment ${id}`,
    created: at,
    updated: at,
    parentId: null,
    external: null,
  };
}

const machine = (m: Message) =>
  m.from.startsWith('run:') ? 'machine' : 'home';

describe('buildTimeline', () => {
  test('messages and comments interleave in time order', () => {
    const entries = buildTimeline(
      [msg('m2', '2026-10-06T09:02:00Z'), msg('m1', '2026-10-06T09:00:00Z')],
      [comment('c1', '2026-10-06T09:01:00Z')],
      machine
    );
    expect(entries.map((e) => e.key)).toEqual(['m1', 'c1', 'm2']);
  });

  test('consecutive chatter folds into one entry naming who talked', () => {
    const entries = buildTimeline(
      [
        msg('a', '2026-10-06T08:24:00Z', {
          from: 'run:r-36',
          to: ['run:r-33'],
        }),
        msg('b', '2026-10-06T08:30:00Z', {
          from: 'run:r-33',
          to: ['run:r-36'],
        }),
        msg('c', '2026-10-06T08:39:00Z', {
          from: 'run:r-36',
          to: ['run:r-33'],
        }),
        msg('d', '2026-10-06T08:40:00Z'),
        msg('e', '2026-10-06T08:41:00Z', {
          from: 'run:r-36',
          to: ['task:t-1'],
        }),
      ],
      [],
      machine
    );
    expect(entries.map((e) => e.kind)).toEqual(['fold', 'message', 'fold']);
    const fold = entries[0];
    if (fold.kind !== 'fold') throw new Error('not a fold');
    expect(fold.messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(fold.between).toEqual(['run:r-36', 'run:r-33']);
    expect([fold.first, fold.last]).toEqual([
      '2026-10-06T08:24:00Z',
      '2026-10-06T08:39:00Z',
    ]);
  });

  test('a comment between chatter splits the fold', () => {
    const entries = buildTimeline(
      [
        msg('a', '2026-10-06T08:00:00Z', { from: 'run:r-1' }),
        msg('b', '2026-10-06T08:02:00Z', { from: 'run:r-1' }),
      ],
      [comment('c', '2026-10-06T08:01:00Z')],
      machine
    );
    expect(entries.map((e) => e.kind)).toEqual(['fold', 'comment', 'fold']);
  });
});

describe('quoteOf', () => {
  test('a reply quotes its parent in one line, cut at 60', () => {
    const parent = msg('p', '2026-10-06T08:52:00Z', {
      body: 'Section 3 says 401 for an expired refresh token, is that still right after the change?',
    });
    const reply = msg('r', '2026-10-06T09:00:00Z', { replyTo: 'p' });
    expect(quoteOf(reply, new Map([['p', parent]]))).toEqual({
      from: 'human:sam',
      at: '2026-10-06T08:52:00Z',
      text: 'Section 3 says 401 for an expired refresh token, is that st…',
    });
  });

  test('no parent in view, no quote', () => {
    expect(quoteOf(msg('r', 'x', { replyTo: 'gone' }), new Map())).toBeNull();
  });
});
