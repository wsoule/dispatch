import type {
  MergeQueueEntry,
  MergeQueueEntryState,
  RunMeta,
} from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import type { FeedState } from './feedState';
import {
  deriveFeedState,
  deriveTaskFeedState,
  FEED_STATE_LABEL,
  FEED_STATE_ORDER,
  isInFlightState,
  isUrgentState,
} from './feedState';

// Only the fields deriveFeedState reads, matching the fixture style in runState.test.ts.
function run(over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-abc123',
    taskId: 't-abc123',
    taskTitle: 'Do the thing',
    executor: 'claude',
    state: 'finished',
    branch: 'dispatch/t-abc123',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...over,
  } as RunMeta;
}

function entry(state: MergeQueueEntryState): MergeQueueEntry {
  return {
    runId: 'r-abc123',
    taskId: 't-abc123',
    taskTitle: 'Do the thing',
    state,
    enqueuedAt: '2026-07-26T00:00:00.000Z',
  };
}

describe('deriveFeedState — runs with no queue entry', () => {
  test.each([
    ['provisioning', 'working'],
    ['running', 'working'],
    ['awaiting-approval', 'approve'],
  ] as [RunMeta['state'], FeedState][])('%s -> %s', (state, expected) => {
    expect(deriveFeedState(run({ state }))).toBe(expected);
  });

  test('finished and unreviewed needs a review', () => {
    expect(deriveFeedState(run({ state: 'finished' }))).toBe('review');
  });

  test('an open PR still counts as needing review', () => {
    expect(
      deriveFeedState(run({ state: 'finished', prUrl: 'https://x/pr/1' }))
    ).toBe('review');
  });

  test('failed with a resumable session is failed, not hidden', () => {
    expect(deriveFeedState(run({ state: 'failed', sessionId: 's1' }))).toBe(
      'failed'
    );
  });

  test('failed with nothing to resume from is also failed', () => {
    expect(deriveFeedState(run({ state: 'failed' }))).toBe('failed');
  });

  test('cancelled is failed — it stopped without finishing', () => {
    expect(deriveFeedState(run({ state: 'cancelled' }))).toBe('failed');
  });

  // The one case that leaves the feed entirely. A closed-out run belongs in history; returning
  // null here is what saves every caller from filtering it group by group.
  test('a reviewed run drops out of the feed', () => {
    expect(
      deriveFeedState(
        run({ state: 'finished', reviewedAt: '2026-07-26T01:00:00.000Z' })
      )
    ).toBeNull();
  });
});

describe('deriveFeedState — the queue outranks the run', () => {
  test.each([
    ['queued', 'landing'],
    ['waiting-blockers', 'landing'],
    ['rebasing', 'landing'],
    ['verifying', 'landing'],
    ['merging', 'landing'],
  ] as [MergeQueueEntryState, FeedState][])('%s -> %s', (state, expected) => {
    expect(deriveFeedState(run({ state: 'finished' }), entry(state))).toBe(
      expected
    );
  });

  // A run that was approved and queued must stop reading as "needs review" — the review
  // already happened. This is the whole reason the queue is checked first.
  test('a queued run is landing, not awaiting review', () => {
    expect(deriveFeedState(run({ state: 'finished' }), entry('queued'))).toBe(
      'landing'
    );
  });

  test('a failed queue entry surfaces as failed', () => {
    expect(deriveFeedState(run({ state: 'finished' }), entry('failed'))).toBe(
      'failed'
    );
  });

  // Held on a dirty checkout: nothing advances until a human clears it, so it must not sit in
  // the calm part of the feed looking like it is still making progress.
  test('blocked-environment is its own ask — unblock, not landing', () => {
    expect(
      deriveFeedState(run({ state: 'finished' }), entry('blocked-environment'))
    ).toBe('unblock');
  });

  test('a merged entry falls back to the run itself', () => {
    expect(
      deriveFeedState(
        run({ state: 'finished', reviewedAt: '2026-07-26T01:00:00.000Z' }),
        entry('merged')
      )
    ).toBeNull();
  });

  // An approval gate outranks a stale queue entry that already came to rest.
  test('a merged entry does not mask a live approval', () => {
    expect(
      deriveFeedState(run({ state: 'awaiting-approval' }), entry('merged'))
    ).toBe('approve');
  });
});

describe('deriveTaskFeedState', () => {
  test('ready and blocked', () => {
    expect(deriveTaskFeedState(true)).toBe('ready');
    expect(deriveTaskFeedState(false)).toBe('blocked');
  });
});

describe('state metadata', () => {
  test('every state has a label and a place in the order', () => {
    for (const state of FEED_STATE_ORDER) {
      expect(FEED_STATE_LABEL[state]).toBeTruthy();
    }
    expect(FEED_STATE_ORDER).toHaveLength(Object.keys(FEED_STATE_LABEL).length);
  });

  // The order is load-bearing: rows must not reshuffle under the cursor as counts change, and
  // what needs a human has to stay at the top.
  test('your moves and broken lead the order', () => {
    expect(FEED_STATE_ORDER.slice(0, 6)).toEqual([
      'answer',
      'approve',
      'review',
      'ruling',
      'unblock',
      'failed',
    ]);
  });

  test('exactly the you-tier and broken states are urgent', () => {
    expect(FEED_STATE_ORDER.filter(isUrgentState)).toEqual([
      'answer',
      'approve',
      'review',
      'ruling',
      'unblock',
      'failed',
    ]);
  });

  test('exactly the machine tier is in flight', () => {
    expect(FEED_STATE_ORDER.filter(isInFlightState)).toEqual([
      'working',
      'fixing',
      'checking',
      'landing',
    ]);
  });
});
