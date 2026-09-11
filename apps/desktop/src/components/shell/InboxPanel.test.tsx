import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { DecisionItem } from '../../lib/decisionFeed';
import type { InboxEntry } from '../../lib/inbox';
import { InboxPanel } from './InboxPanel';

function decision(overrides: Partial<DecisionItem>): DecisionItem {
  return {
    id: 'question:q-1',
    kind: 'question',
    summary: 'Which backend should the export use?',
    runId: 'r-1',
    taskId: 't-1',
    taskTitle: 'Export pipeline',
    since: '2026-09-03T10:00:00.000Z',
    ageMs: 60_000,
    state: 'open',
    disposition: 'blocking',
    ...overrides,
  };
}

const entry: InboxEntry = {
  id: '2026-09-03T09:00:00.000Z:Run finished',
  ts: '2026-09-03T09:00:00.000Z',
  title: 'Run finished',
  body: 'Export pipeline · needs review',
  target: { kind: 'run', runId: 'r-9' },
  read: false,
};

const noop = () => {};

test('renders the decision feed under Waiting on you with its open count', () => {
  render(
    <InboxPanel
      decisions={[
        decision({}),
        decision({ id: 'approval:a-1', kind: 'approval' }),
        decision({
          id: 'question:q-2',
          state: 'resolved',
          resolvedAt: '2026-09-03T10:05:00.000Z',
        }),
      ]}
      onOpenDecision={noop}
      entries={[]}
      onNavigate={noop}
      onMarkAllRead={noop}
    />
  );
  expect(screen.getByText('Waiting on you · 2')).toBeTruthy();
  // A resolved item stays visible but is labeled as settled, not by its kind.
  expect(screen.getByText('Resolved')).toBeTruthy();
});

test('clicking a decision row hands the item to onOpenDecision', () => {
  const opened: DecisionItem[] = [];
  const item = decision({});
  render(
    <InboxPanel
      decisions={[item]}
      onOpenDecision={(d) => opened.push(d)}
      entries={[]}
      onNavigate={noop}
      onMarkAllRead={noop}
    />
  );
  fireEvent.click(
    screen.getByRole('button', { name: /Which backend should the export use/ })
  );
  expect(opened).toEqual([item]);
});

test('history entries render under Earlier, and only they get Mark all read', () => {
  render(
    <InboxPanel
      decisions={[decision({})]}
      onOpenDecision={noop}
      entries={[entry]}
      onNavigate={noop}
      onMarkAllRead={noop}
    />
  );
  expect(screen.getByText('Earlier')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Mark all read' })).toBeTruthy();
});

test('no mark-as-read affordance when there is nothing manual to mark', () => {
  render(
    <InboxPanel
      decisions={[decision({})]}
      onOpenDecision={noop}
      entries={[]}
      onNavigate={noop}
      onMarkAllRead={noop}
    />
  );
  expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull();
});

test('empty feed and empty history collapse to the empty state', () => {
  render(
    <InboxPanel
      decisions={[]}
      onOpenDecision={noop}
      entries={[]}
      onNavigate={noop}
      onMarkAllRead={noop}
    />
  );
  expect(screen.getByText('Nothing waiting on you.')).toBeTruthy();
});
