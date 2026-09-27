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
    screen.getAllByRole('group').map((r) => r.getAttribute('aria-label'))
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
  fireEvent.click(screen.getByRole('option', { name: /m-07/ }));
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
  expect(optionNames()).toEqual(['m-02']);
});

// The option the listbox's cursor is on, by its thread id (each root's body).
function cursorName(): string | null {
  const list = screen.getByRole('listbox', { name: 'Threads' });
  const id = list.getAttribute('aria-activedescendant');
  return id === null
    ? null
    : (document.getElementById(id)?.textContent?.match(/^m-\d+/)?.[0] ?? null);
}

function optionNames(): string[] {
  return screen
    .queryAllByRole('option')
    .map((option) => option.textContent?.match(/^m-\d+/)?.[0] ?? '');
}

const THREE_GROUPS = {
  'needs-you': [summary('m-01', { needsYou: true })],
  channels: [summary('m-02', { channel: 'general' })],
  direct: [summary('m-03')],
};

// Like Inbox: one tab stop, not one per thread, so Tab leaves the rail at once.
test('the rail is one tab stop whose rows are options, not tab stops', () => {
  render(
    <ThreadRail
      groups={THREE_GROUPS}
      selected={null}
      onSelect={() => {}}
      lookups={lookups}
    />
  );
  const list = screen.getByRole('listbox', { name: 'Threads' });
  expect(list.tabIndex).toBe(0);
  expect(
    screen
      .getAllByRole('option')
      .map((option) => option.getAttribute('tabindex'))
  ).toEqual([null, null, null]);
});

test('j/k and the arrows move one cursor across the groups, Enter opens and Escape clears', () => {
  const onSelect = mock((_thread: string) => {});
  render(
    <ThreadRail
      groups={THREE_GROUPS}
      selected={null}
      onSelect={onSelect}
      lookups={lookups}
    />
  );
  const list = screen.getByRole('listbox', { name: 'Threads' });
  const press = (key: string) => fireEvent.keyDown(list, { key });

  press('j');
  expect(cursorName()).toBe('m-01');
  press('ArrowDown');
  expect(cursorName()).toBe('m-02');
  press('j');
  press('j');
  expect(cursorName()).toBe('m-03');
  press('k');
  press('ArrowUp');
  expect(cursorName()).toBe('m-01');
  expect(onSelect).not.toHaveBeenCalled();

  press('Enter');
  expect(onSelect).toHaveBeenCalledWith('m-01');
  press('Escape');
  expect(cursorName()).toBeNull();
});

test('the cursor starts from the open thread and skips a collapsed group', () => {
  render(
    <ThreadRail
      groups={THREE_GROUPS}
      selected="m-01"
      onSelect={() => {}}
      lookups={lookups}
    />
  );
  const toggles = () =>
    screen.getAllByRole('button', { name: 'Collapse group' });
  const channels = toggles()[1];
  if (channels === undefined) throw new Error('no Channels toggle');
  fireEvent.click(channels);
  const list = screen.getByRole('listbox', { name: 'Threads' });
  fireEvent.keyDown(list, { key: 'j' });
  expect(cursorName()).toBe('m-03');

  // Collapsing the group under the cursor clears it rather than pointing at nothing.
  const direct = toggles()[1];
  if (direct === undefined) throw new Error('no Direct toggle');
  fireEvent.click(direct);
  expect(cursorName()).toBeNull();
});

test('keys pressed on a group toggle stay with the toggle', () => {
  const onSelect = mock((_thread: string) => {});
  render(
    <ThreadRail
      groups={THREE_GROUPS}
      selected={null}
      onSelect={onSelect}
      lookups={lookups}
    />
  );
  const [toggle] = screen.getAllByRole('button', { name: 'Collapse group' });
  if (toggle === undefined) throw new Error('no group toggle');
  fireEvent.keyDown(toggle, { key: 'j' });
  fireEvent.keyDown(toggle, { key: 'Enter' });
  expect(cursorName()).toBeNull();
  expect(onSelect).not.toHaveBeenCalled();
});
