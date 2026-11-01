import type { DraftRecord } from '@dispatch/client';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { InboxEntry } from '../../lib/inbox';
import { DraftsSection, NotificationsSection } from './InflowSections';

function draft(
  id: string,
  state: DraftRecord['state'],
  extra: Partial<DraftRecord> = {}
): DraftRecord {
  return {
    id,
    prompt: `prompt ${id}`,
    plannerName: 'planner',
    state,
    message: '',
    proposal: null,
    questions: [],
    error: null,
    createdAt: '2026-10-09T09:00:00Z',
    updatedAt: '2026-10-09T09:00:00Z',
    ...extra,
  };
}

test('Drafts lists every draft, opens one on click and dismisses without opening', () => {
  const opened: string[] = [];
  const dismissed: string[] = [];
  render(
    <DraftsSection
      drafts={[
        draft('d-ready', 'ready', {
          proposal: {
            tasks: [{ title: 'Add a wishlist' }, { title: 'Second' }],
          } as unknown as DraftRecord['proposal'],
        }),
        draft('d-run', 'running'),
        draft('d-ask', 'failed', {
          questions: [{ id: 'q' }] as unknown as DraftRecord['questions'],
        }),
      ]}
      onOpen={(id) => opened.push(id)}
      onDismiss={(id) => dismissed.push(id)}
    />
  );
  const rows = screen.getAllByTestId('overseer-draft-row');
  // Running first, then ready, then failed: what is still happening leads.
  expect(rows.map((r) => r.textContent?.split('›')[0])).toEqual([
    'prompt d-run',
    'Add a wishlist',
    'Draft failed',
  ]);
  expect(rows[0]?.textContent).toContain('drafting');
  expect(rows[1]?.textContent).toContain('2 tasks');
  expect(rows[2]?.textContent).toContain('1 question');
  fireEvent.click(screen.getByText('Add a wishlist'));
  expect(opened).toEqual(['d-ready']);
  fireEvent.click(
    within(rows[0]).getByRole('button', {
      name: 'Dismiss draft',
    })
  );
  expect(dismissed).toEqual(['d-run']);
  expect(opened).toEqual(['d-ready']);
});

test('Drafts renders nothing without drafts', () => {
  const { container } = render(
    <DraftsSection drafts={[]} onOpen={() => {}} onDismiss={() => {}} />
  );
  expect(container.textContent).toBe('');
});

function entry(id: string, read: boolean): InboxEntry {
  return {
    id,
    ts: '2026-10-09T09:00:00Z',
    title: `Run ${id} finished`,
    body: `Ship task ${id}`,
    target: { kind: 'task', taskId: `t-${id}` },
    read,
  };
}

test('Notifications marks unread rows, opens one and marks all read', () => {
  const opened: string[] = [];
  let markedAll = 0;
  const entries = Array.from({ length: 7 }, (_, i) => entry(`${i}`, i > 1));
  render(
    <NotificationsSection
      entries={entries}
      unreadCount={2}
      onMarkAllRead={() => markedAll++}
      onOpen={(e) => opened.push(e.id)}
      onDismiss={() => {}}
      onClearAll={() => {}}
    />
  );
  const rows = screen.getAllByTestId('overseer-notification-row');
  // Five show, the rest fold behind "+2 more".
  expect(rows).toHaveLength(5);
  expect(
    rows.filter((r) => r.getAttribute('data-unread') === 'true')
  ).toHaveLength(2);
  fireEvent.click(screen.getByText('+2 more'));
  expect(screen.getAllByTestId('overseer-notification-row')).toHaveLength(7);
  fireEvent.click(screen.getByText('Ship task 3'));
  expect(opened).toEqual(['3']);
  fireEvent.click(screen.getByTestId('overseer-notifications-read-all'));
  expect(markedAll).toBe(1);
});

test('Notifications hides Mark all read once everything is read', () => {
  render(
    <NotificationsSection
      entries={[entry('a', true)]}
      unreadCount={0}
      onMarkAllRead={() => {}}
      onOpen={() => {}}
      onDismiss={() => {}}
      onClearAll={() => {}}
    />
  );
  expect(screen.queryByTestId('overseer-notifications-read-all')).toBeNull();
  // The subject leads the row; the generic kind and body are its tooltip.
  expect(screen.getByText('Ship task a').getAttribute('title')).toBe(
    'Run a finished\nShip task a'
  );
});

test('Notifications dismisses one row without opening it, and clears all', () => {
  const opened: string[] = [];
  const dismissed: string[] = [];
  let cleared = 0;
  render(
    <NotificationsSection
      entries={[entry('a', true), entry('b', false)]}
      unreadCount={1}
      onMarkAllRead={() => {}}
      onOpen={(e) => opened.push(e.id)}
      onDismiss={(id) => dismissed.push(id)}
      onClearAll={() => cleared++}
    />
  );
  fireEvent.click(screen.getAllByTestId('overseer-notification-dismiss')[1]);
  expect(dismissed).toEqual(['b']);
  expect(opened).toEqual([]);
  fireEvent.click(screen.getByTestId('overseer-notifications-clear-all'));
  expect(cleared).toBe(1);
});

test('Notifications shows only the first line of a multi-line body', () => {
  render(
    <NotificationsSection
      entries={[
        {
          ...entry('a', false),
          body: 'Ship task a · git rebase failed: Rebasing (1/2)\nerror: could not apply 0ca7e80c',
        },
      ]}
      unreadCount={1}
      onMarkAllRead={() => {}}
      onOpen={() => {}}
      onDismiss={() => {}}
      onClearAll={() => {}}
    />
  );
  expect(
    screen.getByText('Ship task a · git rebase failed: Rebasing (1/2)')
  ).toBeDefined();
  expect(screen.queryByText(/could not apply/)).toBeNull();
});

test('Notifications offers Hide only when the caller can hide it', () => {
  let hidden = 0;
  const { rerender } = render(
    <NotificationsSection
      entries={[entry('a', true)]}
      unreadCount={0}
      onMarkAllRead={() => {}}
      onOpen={() => {}}
      onDismiss={() => {}}
      onClearAll={() => {}}
    />
  );
  expect(screen.queryByTestId('overseer-notifications-hide')).toBeNull();
  rerender(
    <NotificationsSection
      entries={[entry('a', true)]}
      unreadCount={0}
      onMarkAllRead={() => {}}
      onOpen={() => {}}
      onDismiss={() => {}}
      onClearAll={() => {}}
      onHide={() => hidden++}
    />
  );
  fireEvent.click(screen.getByTestId('overseer-notifications-hide'));
  expect(hidden).toBe(1);
});
