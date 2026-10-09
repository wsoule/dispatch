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
    body: 'body',
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
  fireEvent.click(screen.getByText('Run 3 finished'));
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
    />
  );
  expect(screen.queryByTestId('overseer-notifications-read-all')).toBeNull();
  expect(screen.getByText('Run a finished')).toBeTruthy();
});
