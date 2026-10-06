import type { MailboxItem, Message } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { buildPosts } from './posts';

const ME = 'human:wyat';

function item(
  id: string,
  at: string,
  over: Partial<Message> = {},
  state = 'pushed'
): MailboxItem {
  return {
    delivery: {
      id: `d-${id}`,
      messageId: id,
      recipient: ME,
      runId: null,
      via: 'direct',
      state,
      updatedAt: at,
    },
    message: {
      id,
      thread: id,
      replyTo: null,
      from: 'human:sam',
      to: [ME],
      kind: 'message',
      body: `body ${id}`,
      refs: [],
      urgent: false,
      blocking: false,
      wake: 'none',
      createdAt: at,
      ...over,
    },
  } as MailboxItem;
}

const ctx = {
  me: ME,
  myTaskIds: new Set<string>(),
  followed: new Set(['channel:release']),
  muted: new Set<string>(),
  authorOf: () => null,
  now: Date.parse('2026-10-06T12:00:00Z'),
};

describe('buildPosts', () => {
  test('one post per subject while unread, updated in place', () => {
    const posts = buildPosts(
      [
        item('a', '2026-10-06T09:00:00Z', { to: [ME, 'task:t-1'] }),
        item('b', '2026-10-06T09:05:00Z', { to: [ME, 'task:t-1'] }),
        item('c', '2026-10-06T09:10:00Z'),
      ],
      ctx
    );
    expect(
      posts.map((p) => [p.subject, p.count, p.latest.id, p.unread])
    ).toEqual([
      ['task:t-1', 2, 'b', true],
      ['human:sam', 1, 'c', true],
    ]);
  });

  test('a read post collapses but stays; one older than a day goes', () => {
    const posts = buildPosts(
      [
        item('a', '2026-10-06T09:00:00Z', {}, 'read'),
        item('old', '2026-10-04T09:00:00Z', { from: 'human:lee', to: [ME] }),
      ],
      ctx
    );
    expect(posts.map((p) => [p.latest.id, p.unread])).toEqual([['a', false]]);
  });

  test('chatter, gates and my own messages never make posts', () => {
    const posts = buildPosts(
      [
        item('chat', '2026-10-06T09:00:00Z', {
          from: 'run:r-1',
          to: ['run:r-2'],
        }),
        item('gate', '2026-10-06T09:01:00Z', {
          kind: 'question',
          blocking: true,
          data: { type: 'wake', target: 'task:t-1', message: 'go' },
        }),
        item('mine', '2026-10-06T09:02:00Z', { from: ME, to: ['human:sam'] }),
      ],
      ctx
    );
    expect(posts).toEqual([]);
  });

  test('a followed room makes at most one post per hour', () => {
    const posts = buildPosts(
      [
        item('r1', '2026-10-06T09:05:00Z', { to: ['channel:release'] }),
        item('r2', '2026-10-06T09:40:00Z', { to: ['channel:release'] }),
        item('r3', '2026-10-06T10:10:00Z', { to: ['channel:release'] }),
      ],
      ctx
    );
    expect(posts.map((p) => [p.subject, p.kind, p.count])).toEqual([
      ['channel:release', 'followed', 2],
      ['channel:release', 'followed', 1],
    ]);
  });
});
