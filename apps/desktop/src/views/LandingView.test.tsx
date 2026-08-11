import type { MergeQueueEntry } from '@dispatch/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { LandingView } from './LandingView';

/** A `DispatchProjectData` stub carrying only what LandingView reads. Cast once here so no
 *  individual test has to spell out the ~150 fields it never touches. */
function dataWith(
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
    handleEnqueueMerge: async () => {},
    lastPushError: null,
    ...overrides,
  } as unknown as DispatchProjectData;
}

/** A terminal history entry with only the fields the view renders. */
function historyEntry(
  runId: string,
  state: 'merged' | 'failed',
  overrides: Partial<MergeQueueEntry> = {}
): MergeQueueEntry {
  return {
    runId,
    taskId: `t-${runId}`,
    taskTitle: `Task ${runId}`,
    state,
    enqueuedAt: '2026-08-11T00:00:00.000Z',
    finishedAt: '2026-08-11T00:05:00.000Z',
    ...overrides,
  } as MergeQueueEntry;
}

// The failure this covers: LandingView was written for a full-window page and always
// requested `h-full`/`overflow-y-auto`. Embedded as the last item of the Inbox's own
// `flex-col` scroller, that combination lets it collapse to zero height on a busy Inbox —
// the queue becomes unreachable exactly when it's busiest. LandingView now always sizes to
// its content and scrolls with whatever contains it, since InboxView is its only consumer.
test('sizes to content instead of claiming full height', () => {
  const { container } = render(
    <LandingView data={dataWith()} onOpenRun={() => {}} />
  );
  const root = container.firstElementChild;
  expect(root).not.toBeNull();
  const classList = Array.from(root?.classList ?? []);
  expect(classList).not.toContain('h-full');
  expect(classList).not.toContain('overflow-y-auto');
});

test('a clean queue shows no push-failure banner', () => {
  render(<LandingView data={dataWith()} onOpenRun={() => {}} />);
  expect(screen.queryByText(/push failed/)).toBeNull();
});

// The failure this covers: the queue drains, the branch merges locally, the auto-push to
// origin fails, and nothing on screen says so. Landing owns the banner because Landing is
// where the queue itself is read.
test('a failed drain-push is reported where the queue is', () => {
  render(
    <LandingView
      data={dataWith({ lastPushError: 'remote rejected: non-fast-forward' })}
      onOpenRun={() => {}}
    />
  );
  expect(screen.getByText(/Merged locally — push failed/)).toBeDefined();
  expect(screen.getByText(/non-fast-forward/)).toBeDefined();
});

// Retrying is `handleMergeAllReady`, not `handleRecheckMergeQueue`: kicking the pump with
// nothing new to enqueue is what makes the server retry a failed drain-push (see the
// handler's own comment in useDispatchProject).
test('the banner retry kicks the queue pump', async () => {
  let mergeAllCalls = 0;
  let recheckCalls = 0;
  render(
    <LandingView
      data={dataWith({
        lastPushError: 'origin unreachable',
        handleMergeAllReady: () => {
          mergeAllCalls += 1;
          return Promise.resolve();
        },
        handleRecheckMergeQueue: () => {
          recheckCalls += 1;
          return Promise.resolve();
        },
      })}
      onOpenRun={() => {}}
    />
  );
  // Wrapped in `act` and flushed: the click starts a promise whose `finally` flips the
  // button's busy state back, and an unflushed state update warns.
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retry push' }));
    await Promise.resolve();
  });
  expect(mergeAllCalls).toBe(1);
  expect(recheckCalls).toBe(0);
});

// The failure this covers (screenshot 2026-08-11): an empty queue rendered a "Landing —
// nothing in the queue" header AND a "MERGE QUEUE 0 — Nothing is waiting to land" section,
// two pieces of chrome for one fact. Empty is now exactly one line.
test('an empty queue is one line, not a header plus an empty section', () => {
  render(<LandingView data={dataWith()} onOpenRun={() => {}} />);
  expect(screen.getByText('Merge queue: empty')).toBeDefined();
  expect(screen.queryByText('Landing')).toBeNull();
  expect(screen.queryByText(/Nothing is waiting to land/)).toBeNull();
  expect(screen.queryByText(/Recently landed/)).toBeNull();
  expect(screen.queryByText(/Nothing has landed yet/)).toBeNull();
});

// The failure this covers (same screenshot): four red FAILED rows under a heading that said
// RECENTLY LANDED. Successes and failures are now separate sections, and the failure's error
// is on the row in full, not a truncated monospace fragment.
test('history splits into Landed and Failed to land, with the error legible', () => {
  const reason =
    'lint failed: $ oxlint --type-aware exited 1 with 14 findings across 3 files';
  render(
    <LandingView
      data={dataWith({
        mergeQueue: {
          entries: [],
          history: [
            historyEntry('ok', 'merged', { taskTitle: 'Landed fine' }),
            historyEntry('bad', 'failed', { taskTitle: 'Broke lint', reason }),
          ],
        },
      })}
      onOpenRun={() => {}}
    />
  );

  const landed = screen.getByText('Landed').closest('section');
  expect(landed?.textContent).toContain('Landed fine');
  expect(landed?.textContent).not.toContain('Broke lint');

  const failedSection = screen.getByText('Failed to land').closest('section');
  expect(failedSection?.textContent).toContain('Broke lint');
  // The whole reason, verbatim — not a "lint failed: $ oxlint --typ…" stub.
  expect(failedSection?.textContent).toContain(reason);
});

// Each failed row carries its own retry, which re-enqueues that run — the same action as
// queueing it from review, aimed at the run that fell out of the queue.
test('a failed row retries by re-enqueuing its run', async () => {
  const enqueued: string[] = [];
  let navigated = 0;
  render(
    <LandingView
      data={dataWith({
        mergeQueue: {
          entries: [],
          history: [
            historyEntry('bad', 'failed', {
              taskTitle: 'Broke tests',
              reason: 'test timed out after 1500s',
            }),
          ],
        },
        handleEnqueueMerge: async (runId: string) => {
          enqueued.push(runId);
        },
      } as unknown as Partial<DispatchProjectData>)}
      onOpenRun={() => {
        navigated += 1;
      }}
    />
  );

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retry: Broke tests' }));
    await Promise.resolve();
  });
  expect(enqueued).toEqual(['bad']);
  // The row navigates on click; the retry button must not also open the run.
  expect(navigated).toBe(0);
});

// A failed attempt whose run has since been reviewed (merged, discarded, PR'd — or landed
// by a later queue attempt) is stale history: it collapses behind a disclosure instead of
// headlining as a failure that still needs someone.
test('failures of already-reviewed runs collapse behind a stale disclosure', () => {
  render(
    <LandingView
      data={dataWith({
        runs: [{ id: 'old', reviewedAt: '2026-08-11T01:00:00.000Z' }],
        mergeQueue: {
          entries: [],
          history: [
            historyEntry('old', 'failed', {
              taskTitle: 'Since reviewed',
              reason: 'run was already reviewed when the queue got to it',
            }),
          ],
        },
      } as unknown as Partial<DispatchProjectData>)}
      onOpenRun={() => {}}
    />
  );

  expect(screen.queryByText('Failed to land')).toBeNull();
  expect(screen.queryByText('Since reviewed')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Show 1 stale attempt' }));
  expect(screen.getByText('Since reviewed')).toBeDefined();
});
