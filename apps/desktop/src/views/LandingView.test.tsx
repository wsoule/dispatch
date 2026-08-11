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
    retryEnsureDispatchd: () => {},
    mergeQueue: { entries: [], history: [] },
    handleRecheckMergeQueue: async () => {},
    handleMergeAllReady: async () => {},
    lastPushError: null,
    ...overrides,
  } as unknown as DispatchProjectData;
}

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
