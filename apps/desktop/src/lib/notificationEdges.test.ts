import type { MergeQueueEntry, RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  diffQueueNotifications,
  diffRunNotifications,
} from './notificationEdges';

// Minimal RunMeta fixture — only the fields diffRunNotifications reads
// (id/state/taskTitle) need real values; everything else is filler.
function run(
  id: string,
  state: RunMeta['state'],
  taskTitle = `task-${id}`
): RunMeta {
  return {
    id,
    taskId: `t-${id}`,
    taskTitle,
    executor: 'fake',
    state,
    branch: `b-${id}`,
    baseBranch: 'main',
    worktreePath: `/tmp/${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

// Minimal MergeQueueEntry fixture — mirrors `run` above for queue entries.
function entry(
  runId: string,
  state: MergeQueueEntry['state'],
  extra: Partial<MergeQueueEntry> = {}
): MergeQueueEntry {
  return {
    runId,
    taskId: `t-${runId}`,
    taskTitle: `task-${runId}`,
    state,
    enqueuedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

describe('diffRunNotifications', () => {
  test('a run seen for the first time never notifies, regardless of its state', () => {
    const { notifications, next } = diffRunNotifications(new Map(), [
      run('a', 'finished'),
      run('b', 'failed'),
      run('c', 'running'),
    ]);
    expect(notifications).toEqual([]);
    expect(next.get('a')).toBe('finished');
    expect(next.get('b')).toBe('failed');
    expect(next.get('c')).toBe('running');
  });

  test('running -> finished notifies once with the task title', () => {
    const previous = new Map([['a', 'running' as const]]);
    const { notifications } = diffRunNotifications(previous, [
      run('a', 'finished', 'Ship the thing'),
    ]);
    expect(notifications).toEqual([
      { title: 'Run finished', body: 'Ship the thing' },
    ]);
  });

  test('running -> failed notifies with "Run failed"', () => {
    const previous = new Map([['a', 'running' as const]]);
    const { notifications } = diffRunNotifications(previous, [
      run('a', 'failed', 'Ship the thing'),
    ]);
    expect(notifications).toEqual([
      { title: 'Run failed', body: 'Ship the thing' },
    ]);
  });

  test('a non-terminal transition (running -> awaiting-approval) does not notify', () => {
    const previous = new Map([['a', 'running' as const]]);
    const { notifications } = diffRunNotifications(previous, [
      run('a', 'awaiting-approval'),
    ]);
    expect(notifications).toEqual([]);
  });

  test('no state change does not notify', () => {
    const previous = new Map([['a', 'finished' as const]]);
    const { notifications } = diffRunNotifications(previous, [
      run('a', 'finished'),
    ]);
    expect(notifications).toEqual([]);
  });

  test('next only tracks runs from the latest list, not accumulated history', () => {
    const previous = new Map([
      ['a', 'finished' as const],
      ['stale', 'running' as const],
    ]);
    const { next } = diffRunNotifications(previous, [run('a', 'finished')]);
    expect(next.has('stale')).toBe(false);
    expect(next.size).toBe(1);
  });
});

describe('diffQueueNotifications', () => {
  test('an entry seen for the first time never notifies', () => {
    const { notifications } = diffQueueNotifications(new Map(), [
      entry('r1', 'merged'),
      entry('r2', 'failed'),
    ]);
    expect(notifications).toEqual([]);
  });

  test('merging -> merged notifies "Merged" with the task title', () => {
    const previous = new Map([['r1', 'merging' as const]]);
    const { notifications } = diffQueueNotifications(previous, [
      entry('r1', 'merged', { taskTitle: 'Add feature' }),
    ]);
    expect(notifications).toEqual([{ title: 'Merged', body: 'Add feature' }]);
  });

  test('verifying -> failed notifies "Merge failed" with task title and reason, truncated to 80 chars', () => {
    const previous = new Map([['r1', 'verifying' as const]]);
    const longReason = 'x'.repeat(120);
    const { notifications } = diffQueueNotifications(previous, [
      entry('r1', 'failed', { taskTitle: 'Add feature', reason: longReason }),
    ]);
    expect(notifications).toHaveLength(1);
    const [note] = notifications;
    expect(note.title).toBe('Merge failed');
    expect(note.body).toBe(`Add feature — ${'x'.repeat(80)}`);
  });

  test('a missing reason falls back to an empty string rather than "undefined"', () => {
    const previous = new Map([['r1', 'verifying' as const]]);
    const { notifications } = diffQueueNotifications(previous, [
      entry('r1', 'failed', { taskTitle: 'Add feature' }),
    ]);
    expect(notifications).toEqual([
      { title: 'Merge failed', body: 'Add feature — ' },
    ]);
  });

  test('the combined entries+history list catches the active -> terminal move', () => {
    // Simulates the real shape: an entry that was 'merging' in `entries` moves out
    // of `entries` and into `history` as 'merged' in the same snapshot.
    const previous = new Map([['r1', 'merging' as const]]);
    const nextEntries: MergeQueueEntry[] = []; // r1 no longer active
    const nextHistory: MergeQueueEntry[] = [entry('r1', 'merged')];
    const { notifications } = diffQueueNotifications(previous, [
      ...nextEntries,
      ...nextHistory,
    ]);
    expect(notifications).toEqual([{ title: 'Merged', body: `task-r1` }]);
  });

  test('no state change does not notify', () => {
    const previous = new Map([['r1', 'merged' as const]]);
    const { notifications } = diffQueueNotifications(previous, [
      entry('r1', 'merged'),
    ]);
    expect(notifications).toEqual([]);
  });

  test('re-enqueued run (appears in both entries and history) keeps current state and does not notify', () => {
    // Simulates: prev {r1: merged}, next {r1 merged in entries + r1 failed in history}.
    // The entries version is current (merged after re-enqueue), history is stale (older failure).
    // First-wins means next should be {r1: merged}, and no notification fires.
    const previous = new Map([['r1', 'merged' as const]]);
    const nextEntries: MergeQueueEntry[] = [entry('r1', 'merged')];
    const nextHistory: MergeQueueEntry[] = [
      entry('r1', 'failed', { reason: 'older failure' }),
    ];
    const { notifications, next } = diffQueueNotifications(previous, [
      ...nextEntries,
      ...nextHistory,
    ]);
    expect(notifications).toEqual([]);
    expect(next.get('r1')).toBe('merged');
  });

  test('re-enqueued run re-appearing in same state does not spuriously re-fire notification', () => {
    // Simulates the spurious-refire bug: prev {r1: merged from entries}, next {same lists again}.
    // With the bug, older history entry overwrites next.set() and a stale state causes a spurious
    // "state changed" notification. With first-wins, next stays {r1: merged} and no notification fires.
    const previous = new Map([['r1', 'merged' as const]]);
    const entries: MergeQueueEntry[] = [entry('r1', 'merged')];
    const history: MergeQueueEntry[] = [
      entry('r1', 'failed', { reason: 'old attempt' }),
    ];
    const { notifications, next } = diffQueueNotifications(previous, [
      ...entries,
      ...history,
    ]);
    expect(notifications).toEqual([]);
    expect(next.get('r1')).toBe('merged');
  });
});
