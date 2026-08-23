import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { FeedRowModel } from '../lib/controlRoom';
import type { InboxData } from '../lib/inboxQueue';
import { InboxView } from './InboxView';

/** A `DispatchProjectData` stub carrying only what InboxView reads — the
 *  daemon-availability fields plus the two merge-queue actions. */
function projectWith(
  overrides: Partial<DispatchProjectData> = {}
): DispatchProjectData {
  return {
    portLoading: false,
    portError: false,
    portErrorDetail: null,
    client: {},
    runs: [],
    retryEnsureDispatchd: () => {},
    openQuestions: new Map(),
    handleMergeAllReady: async () => {},
    handleEnqueueMerge: async () => {},
    handleAnswerQuestion: async () => {},
    ...overrides,
  } as unknown as DispatchProjectData;
}

function row(over: Partial<FeedRowModel> = {}): FeedRowModel {
  return {
    runId: 'r-1',
    taskId: 't-1',
    title: 'Do the thing',
    state: 'review',
    epicTitle: null,
    since: '2026-08-10T00:00:00.000Z',
    activity: null,
    attention: null,
    fixLoop: null,
    ...over,
  };
}

function dataWith(sections: InboxData['sections']): InboxData {
  const total = sections.reduce((n, s) => n + s.rows.length, 0);
  return { sections, prs: [], total };
}

test('sections render in feed order with the whose-move labels', () => {
  render(
    <InboxView
      data={dataWith([
        {
          state: 'answer',
          rows: [row({ taskId: 't-a', runId: 'r-a', state: 'answer' })],
        },
        {
          state: 'review',
          rows: [
            row({ taskId: 't-b', runId: 'r-b' }),
            row({ taskId: 't-c', runId: 'r-c', title: 'Second review' }),
          ],
        },
        {
          state: 'failed',
          rows: [
            row({
              taskId: 't-d',
              runId: 'r-d',
              state: 'failed',
              attention: { reason: 'boom', detail: null },
            }),
          ],
        },
      ])}
      project={projectWith()}
      onOpenTask={() => {}}
      onOpenPr={() => {}}
    />
  );

  expect(screen.getByText('Answer').closest('section')).not.toBeNull();
  expect(screen.getByText('Review').closest('section')).not.toBeNull();
  expect(screen.getByText('Failed').closest('section')).not.toBeNull();
  // The row says why it needs a human, right in the row.
  expect(screen.queryByText('boom')).not.toBeNull();
});

test('an empty inbox says so instead of rendering empty sections', () => {
  render(
    <InboxView
      data={{ sections: [], prs: [], total: 0 }}
      project={projectWith()}
      onOpenTask={() => {}}
      onOpenPr={() => {}}
    />
  );
  expect(screen.queryByText('Nothing waiting on you.')).not.toBeNull();
});

// The merge affordances: the section header queues everything ready; each
// review row can queue just itself — without navigating.
test('queue-merge affordances call the queue, not navigation', () => {
  const calls: string[] = [];
  let mergeAll = 0;
  let navigated = 0;

  render(
    <InboxView
      data={dataWith([
        {
          state: 'review',
          rows: [
            row({ title: 'Ready to land' }),
            row({ taskId: 't-2', runId: 'r-2', title: 'Also ready' }),
          ],
        },
      ])}
      project={projectWith({
        handleMergeAllReady: async () => {
          mergeAll += 1;
        },
        handleEnqueueMerge: async (runId: string) => {
          calls.push(runId);
        },
      } as unknown as Partial<DispatchProjectData>)}
      onOpenTask={() => {
        navigated += 1;
      }}
      onOpenPr={() => {}}
    />
  );

  fireEvent.click(screen.getByRole('button', { name: /queue all for merge/i }));
  expect(mergeAll).toBe(1);

  fireEvent.click(
    screen.getByRole('button', { name: 'Queue merge: Ready to land' })
  );
  expect(calls).toEqual(['r-1']);
  expect(navigated).toBe(0);
});

test('an unclaimed PR renders with its number and opens the PR page', () => {
  const opened: number[] = [];
  render(
    <InboxView
      data={{
        sections: [],
        prs: [
          {
            number: 9,
            url: 'https://github.com/x/y/pull/9',
            title: 'Standalone PR',
            updatedAt: '2026-08-10T00:00:00.000Z',
          } as InboxData['prs'][number],
        ],
        total: 1,
      }}
      project={projectWith()}
      onOpenTask={() => {}}
      onOpenPr={(n) => opened.push(n)}
    />
  );
  fireEvent.click(screen.getByText('Standalone PR'));
  expect(opened).toEqual([9]);
});
