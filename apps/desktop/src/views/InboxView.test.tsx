import type { RunMeta } from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { InboxData } from '../lib/inboxQueue';
import { InboxView } from './InboxView';

/** A `DispatchProjectData` stub carrying only what InboxView (via the embedded
 *  LandingView) reads. */
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

// The failure this covers: LandingView (the merge queue) sits as the last item of the
// Inbox's own scroller. On a busy Inbox — plenty of waiting and needs-review rows — a
// layout defect could squeeze it to zero height. happy-dom can't compute real layout, so
// this only pins the DOM-level contract: the merge queue section still renders in the
// document even when the two lists above it are full.
test('a busy Inbox still renders the merge queue section', () => {
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
  // The queue is empty here, so its whole footprint is the one-line empty state.
  expect(screen.getByText('Merge queue: empty')).toBeDefined();
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

// The two sections must tell one story: a run still in Needs review whose latest queue
// attempt failed carries a badge, so the review row itself says the queue bounced it. A
// run whose failure was followed by a merged attempt gets no badge — latest attempt wins.
test('a needs-review run whose latest queue attempt failed is badged', () => {
  const runOf = (id: string) =>
    ({ ...waitingRun(id), state: 'finished' }) as unknown as RunMeta;
  const review: InboxData['review'] = [
    {
      target: { kind: 'run', runId: 'bounced' },
      run: runOf('bounced'),
      title: 'Bounced by verify',
      isPr: false,
      updatedAt: '2026-08-10T00:00:00.000Z',
    },
    {
      target: { kind: 'run', runId: 'fine' },
      run: runOf('fine'),
      title: 'Never queued',
      isPr: false,
      updatedAt: '2026-08-10T00:00:00.000Z',
    },
  ];
  const history = [
    {
      runId: 'bounced',
      taskId: 't-bounced',
      taskTitle: 'Bounced by verify',
      state: 'failed',
      reason: 'verify failed',
      enqueuedAt: '2026-08-10T00:00:00.000Z',
      finishedAt: '2026-08-10T00:05:00.000Z',
    },
  ];

  render(
    <InboxView
      data={{ waiting: [], review }}
      project={projectWith({
        mergeQueue: { entries: [], history },
      } as unknown as Partial<DispatchProjectData>)}
      onOpenTask={() => {}}
      onOpenPr={() => {}}
    />
  );

  const badges = screen.getAllByText('verify failed');
  // Once as the badge on the review row; the failure row below repeats the reason text.
  const badge = badges.find((el) =>
    el.closest('button')?.textContent?.includes('Bounced by verify')
  );
  expect(badge).toBeDefined();
  expect(
    screen
      .getAllByRole('button')
      .find((b) => b.textContent?.includes('Never queued'))?.textContent
  ).not.toContain('verify failed');
});
