import type { Message } from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import type { ThreadSummary } from '../../lib/threads';
import { threadLookups } from '../../lib/threadSources';
import { ThreadRail } from './ThreadRail';

function msg(id: string, over: Partial<Message> = {}): Message {
  return {
    id,
    thread: id,
    replyTo: null,
    from: 'run:r-000001',
    to: ['human:wyat'],
    kind: 'message',
    body: id,
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-09-25T10:00:00.000Z',
    ...over,
  };
}

function summary(
  thread: string,
  over: Partial<ThreadSummary> = {}
): ThreadSummary {
  const root = msg(thread);
  return {
    thread,
    root,
    last: root,
    count: 1,
    unread: 0,
    needsYou: false,
    channel: null,
    participants: ['run:r-000001'],
    ...over,
  };
}

const lookups = threadLookups([], [], []);

test('renders Needs you, Channels and Direct in that order, with unread counts', () => {
  render(
    <ThreadRail
      groups={{
        'needs-you': [summary('m-01', { needsYou: true, unread: 2 })],
        channels: [summary('m-02', { channel: 'general' })],
        direct: [],
      }}
      selected={null}
      onSelect={() => {}}
      lookups={lookups}
    />
  );
  expect(
    screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))
  ).toEqual(['Needs you', 'Channels', 'Direct']);
  expect(screen.getByLabelText('2 unread')).toBeTruthy();
});

test('a row selects its thread', () => {
  const onSelect = mock((_thread: string) => {});
  render(
    <ThreadRail
      groups={{ 'needs-you': [], channels: [], direct: [summary('m-07')] }}
      selected={null}
      onSelect={onSelect}
      lookups={lookups}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: /m-07/ }));
  expect(onSelect).toHaveBeenCalledWith('m-07');
});

test('collapsing a group hides its rows and keeps the others', () => {
  render(
    <ThreadRail
      groups={{
        'needs-you': [summary('m-01', { needsYou: true })],
        channels: [],
        direct: [summary('m-02')],
      }}
      selected={null}
      onSelect={() => {}}
      lookups={lookups}
    />
  );
  const [needsYouToggle] = screen.getAllByRole('button', {
    name: 'Collapse group',
  });
  if (needsYouToggle === undefined) throw new Error('no group toggle');
  fireEvent.click(needsYouToggle);
  expect(screen.queryByRole('button', { name: /m-01/ })).toBeNull();
  expect(screen.getByRole('button', { name: /m-02/ })).toBeTruthy();
});
