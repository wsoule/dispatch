import type { RunMeta } from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { DispatchProjectData } from '../hooks/useDispatchProject';
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
    mergeQueue: { entries: [], history: [] },
    handleRecheckMergeQueue: async () => {},
    handleMergeAllReady: async () => {},
    lastPushError: null,
    ...overrides,
  } as unknown as DispatchProjectData;
}

function waitingRun(id: string): RunMeta {
  return {
    id,
    taskId: `t-${id}`,
    taskTitle: `Waiting run ${id}`,
    executor: 'claude',
    state: 'waiting',
    branch: `b-${id}`,
    baseBranch: 'main',
    worktreePath: '',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  } as unknown as RunMeta;
}

// The Inbox used to end with the merge queue embedded as its last item, which showed a
// second, partial copy of what the Landing table now owns. The queue section is gone; the
// two lists — and the inline queue-merge actions below — are what this page still is.
test('a busy Inbox renders its two lists and no embedded merge queue', () => {
  const waiting: RunMeta[] = Array.from({ length: 15 }, (_, i) =>
    waitingRun(`w${i}`)
  );
  const review: InboxData['review'] = Array.from({ length: 10 }, (_, i) => ({
    target: { kind: 'run', runId: `r${i}` },
    title: `Needs review ${i}`,
    isPr: false,
    updatedAt: '2026-08-10T00:00:00.000Z',
  }));

  render(
    <InboxView
      data={{ waiting, review }}
      project={projectWith()}
      onOpenTask={() => {}}
      onOpenPr={() => {}}
    />
  );

  expect(screen.getByText('Waiting on you').closest('section')).not.toBeNull();
  expect(screen.getByText('Needs review').closest('section')).not.toBeNull();
  expect(screen.queryByText('Merge queue')).toBeNull();
});

// The merge affordances added 2026-08-11: reviews used to be open-one-click-merge-
// one, six times over. The section header queues everything ready; each run-backed
// row can queue just itself — without navigating.
test('queue-merge affordances call the queue, not navigation', () => {
  const calls: string[] = [];
  let mergeAll = 0;
  let navigated = 0;
  const run = {
    ...waitingRun('r1'),
    state: 'finished',
  } as unknown as RunMeta;
  const review: InboxData['review'] = [
    {
      target: { kind: 'run', runId: 'r1' },
      run,
      title: 'Ready to land',
      isPr: false,
      updatedAt: '2026-08-10T00:00:00.000Z',
    },
  ];

  render(
    <InboxView
      data={{ waiting: [], review }}
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
  expect(calls).toEqual(['r1']);
  expect(navigated).toBe(0);
});
