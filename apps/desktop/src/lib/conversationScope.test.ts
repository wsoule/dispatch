import type { Message } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { type ScopeContext, scopeOf, subjectOf } from './conversationScope';

const ME = 'human:wyat';

function msg(over: Partial<Message>): Message {
  return {
    id: 'm',
    thread: 'm',
    replyTo: null,
    from: 'human:sam',
    to: [ME],
    kind: 'message',
    body: 'hi',
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-10-06T09:00:00.000Z',
    ...over,
  } as Message;
}

const ctx: ScopeContext = {
  me: ME,
  myTaskIds: new Set(['t-1']),
  followed: new Set(['channel:release']),
  muted: new Set(['human:noisy']),
  authorOf: (id) => (id === 'mine' ? ME : id === 'theirs' ? 'human:sam' : null),
};

describe('scopeOf', () => {
  // Every root shape the bus produces, and where it goes.
  test.each([
    [
      'a gate is Needs you',
      msg({
        kind: 'question',
        blocking: true,
        data: { type: 'wake', target: 'task:t-1', message: 'go' },
      }),
      'gate',
    ],
    ['my own message stays home', msg({ from: ME, to: ['human:sam'] }), 'home'],
    ['a muted sender stays home', msg({ from: 'human:noisy' }), 'home'],
    ['a DM is for you', msg({}), 'for-you'],
    [
      'an @mention is for you',
      msg({ to: ['task:t-9'], body: 'ping @wyat about it' }),
      'for-you',
    ],
    [
      'a reply to me is for you',
      msg({ to: ['task:t-9'], replyTo: 'mine' }),
      'for-you',
    ],
    [
      'a reply to someone else stays home',
      msg({ to: ['task:t-9'], replyTo: 'theirs' }),
      'home',
    ],
    [
      'a handoff to my task is for you',
      msg({ kind: 'handoff', to: ['task:t-1'] }),
      'for-you',
    ],
    [
      'a handoff to another task stays home',
      msg({ kind: 'handoff', to: ['task:t-9'] }),
      'home',
    ],
    [
      'run to run chatter is machine',
      msg({ from: 'run:r-1', to: ['run:r-2'] }),
      'machine',
    ],
    [
      'a run notice to a task is machine',
      msg({ from: 'run:r-1', to: ['task:t-1'], kind: 'notice' }),
      'machine',
    ],
    [
      'a breaker trip is for you',
      msg({
        from: 'agent:dispatch',
        to: ['task:t-1'],
        data: { type: 'x-breaker' },
      }),
      'for-you',
    ],
    [
      'outside traffic is never folded',
      msg({ from: 'a2a:acme', to: ['task:t-9'] }),
      'home',
    ],
    ['outside traffic to me is for you', msg({ from: 'a2a:acme' }), 'for-you'],
    ['a followed room', msg({ to: ['channel:release'] }), 'followed'],
    ['an unfollowed room stays home', msg({ to: ['channel:other'] }), 'home'],
  ] as const)('%s', (_, message, scope) => {
    expect(scopeOf(message, ctx)).toBe(scope);
  });
});

describe('subjectOf', () => {
  test('a task wins, then a room, then the other party', () => {
    expect(subjectOf(msg({ to: ['channel:release', 'task:t-1'] }), ME)).toBe(
      'task:t-1'
    );
    expect(subjectOf(msg({ to: ['channel:release'] }), ME)).toBe(
      'channel:release'
    );
    expect(subjectOf(msg({}), ME)).toBe('human:sam');
    expect(subjectOf(msg({ from: ME, to: ['human:sam'] }), ME)).toBe(
      'human:sam'
    );
  });

  test('a task named only in refs is still the subject', () => {
    expect(
      subjectOf(
        msg({ refs: [{ type: 'task', id: 't-3' }] as Message['refs'] }),
        ME
      )
    ).toBe('task:t-3');
  });
});

describe('mentions', () => {
  const dotted: ScopeContext = { ...ctx, me: 'human:a.b' };
  test('a handle with a dot only matches itself', () => {
    expect(scopeOf(msg({ to: ['task:t-9'], body: 'hey @a.b' }), dotted)).toBe(
      'for-you'
    );
    expect(scopeOf(msg({ to: ['task:t-9'], body: 'hey @axb' }), dotted)).toBe(
      'home'
    );
    expect(scopeOf(msg({ to: ['task:t-9'], body: 'hey @a.bc' }), dotted)).toBe(
      'home'
    );
  });
});
