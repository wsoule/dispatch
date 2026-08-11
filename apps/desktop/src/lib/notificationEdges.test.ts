import type {
  DraftRecord,
  MergeQueueEntry,
  PlannerQuestion,
  PlanRecord,
  RunMeta,
  RunQuestion,
} from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  diffQuestionNotifications,
  diffQueueNotifications,
  diffRunNotifications,
  emptyQuestionTracking,
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
      {
        title: 'Run finished',
        body: 'Ship the thing',
        target: { kind: 'run', runId: 'a' },
      },
    ]);
  });

  test('running -> failed notifies with "Run failed"', () => {
    const previous = new Map([['a', 'running' as const]]);
    const { notifications } = diffRunNotifications(previous, [
      run('a', 'failed', 'Ship the thing'),
    ]);
    expect(notifications).toEqual([
      {
        title: 'Run failed',
        body: 'Ship the thing',
        target: { kind: 'run', runId: 'a' },
      },
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
    expect(notifications).toEqual([
      { title: 'Merged', body: 'Add feature', target: { kind: 'queue' } },
    ]);
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
    expect(note.body).toBe(`Add feature · ${'x'.repeat(80)}`);
    expect(note.target).toEqual({ kind: 'queue' });
  });

  // A blocked merge is the one non-terminal state that needs the person, and
  // the original bug was that it happened silently.
  test('queued -> blocked-environment notifies with the actionable reason', () => {
    const previous = new Map([['r1', 'queued' as const]]);
    const { notifications } = diffQueueNotifications(previous, [
      entry('r1', 'blocked-environment', {
        taskTitle: 'Add feature',
        reason: 'main checkout has uncommitted changes: stray.zip',
      }),
    ]);
    expect(notifications).toEqual([
      {
        title: 'Merge blocked. Action needed.',
        body: 'Add feature · main checkout has uncommitted changes: stray.zip',
        target: { kind: 'queue' },
      },
    ]);
  });

  // Re-blocking on the same reason must not re-notify every pump — the state
  // hasn't changed, so the edge detector's own equality check covers it.
  test('staying blocked does not notify again', () => {
    const previous = new Map([['r1', 'blocked-environment' as const]]);
    const { notifications } = diffQueueNotifications(previous, [
      entry('r1', 'blocked-environment', { taskTitle: 'Add feature' }),
    ]);
    expect(notifications).toEqual([]);
  });

  test('a missing reason falls back to an empty string rather than "undefined"', () => {
    const previous = new Map([['r1', 'verifying' as const]]);
    const { notifications } = diffQueueNotifications(previous, [
      entry('r1', 'failed', { taskTitle: 'Add feature' }),
    ]);
    expect(notifications).toEqual([
      {
        title: 'Merge failed',
        body: 'Add feature · ',
        target: { kind: 'queue' },
      },
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
    expect(notifications).toEqual([
      { title: 'Merged', body: `task-r1`, target: { kind: 'queue' } },
    ]);
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

function draft(id: string, questions: PlannerQuestion[]): DraftRecord {
  return {
    id,
    prompt: 'add an export button',
    plannerName: 'claude',
    state: 'ready',
    message: '',
    proposal: null,
    questions,
    error: null,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  };
}

const Q1: PlannerQuestion = { id: 'q1', question: 'Scope?', options: [] };
const Q1_AGAIN: PlannerQuestion = {
  id: 'q1',
  question: 'Which format?',
  options: [],
};

describe('diffQuestionNotifications', () => {
  // An unanswered question is a live obligation from the first call, unlike
  // diffRunNotifications/diffQueueNotifications' states.
  test('a first sighting of a live question notifies', () => {
    const { notifications, next } = diffQuestionNotifications(
      emptyQuestionTracking(),
      [draft('d-1', [Q1])],
      undefined,
      new Map()
    );
    expect(notifications).toHaveLength(1);
    expect(next.askers.has('draft:d-1')).toBe(true);
  });

  test('a first sighting with no questions does not notify', () => {
    const { notifications } = diffQuestionNotifications(
      emptyQuestionTracking(),
      [draft('d-1', [])],
      undefined,
      new Map()
    );
    expect(notifications).toHaveLength(0);
  });

  test('notifies when a tracked draft gains questions', () => {
    const first = diffQuestionNotifications(
      emptyQuestionTracking(),
      [draft('d-1', [])],
      undefined,
      new Map()
    );
    const { notifications } = diffQuestionNotifications(
      first.next,
      [draft('d-1', [Q1])],
      undefined,
      new Map()
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0].target).toEqual({ kind: 'draft', draftId: 'd-1' });
  });

  test('an unchanged question set does not re-notify', () => {
    const first = diffQuestionNotifications(
      emptyQuestionTracking(),
      [draft('d-1', [])],
      undefined,
      new Map()
    );
    const second = diffQuestionNotifications(
      first.next,
      [draft('d-1', [Q1])],
      undefined,
      new Map()
    );
    expect(second.notifications).toHaveLength(1);
    const third = diffQuestionNotifications(
      second.next,
      [draft('d-1', [Q1])],
      undefined,
      new Map()
    );
    expect(third.notifications).toHaveLength(0);
  });

  // Planner question ids are model-authored and only unique within a turn, so a
  // second round routinely reuses "q1". Keying on ids alone would go silent.
  test('a second round reusing the id q1 still notifies', () => {
    const first = diffQuestionNotifications(
      emptyQuestionTracking(),
      [draft('d-1', [Q1])],
      undefined,
      new Map()
    );
    const { notifications } = diffQuestionNotifications(
      first.next,
      [draft('d-1', [Q1_AGAIN])],
      undefined,
      new Map()
    );
    expect(notifications).toHaveLength(1);
  });

  // A `|`-joined signature lets a question body containing "|" collide two
  // structurally different sets onto the same string — this pins the JSON encoding.
  test('question sets that would collide under a delimiter-joined signature still notify', () => {
    const collideA: PlannerQuestion = { id: 'x', question: 'a|b', options: [] };
    const collideB: PlannerQuestion = { id: 'x|a', question: 'b', options: [] };
    const first = diffQuestionNotifications(
      emptyQuestionTracking(),
      [draft('d-1', [collideA])],
      undefined,
      new Map()
    );
    const { notifications } = diffQuestionNotifications(
      first.next,
      [draft('d-1', [collideB])],
      undefined,
      new Map()
    );
    expect(notifications).toHaveLength(1);
  });

  test('an answered draft does not notify', () => {
    const first = diffQuestionNotifications(
      emptyQuestionTracking(),
      [draft('d-1', [Q1])],
      undefined,
      new Map()
    );
    const { notifications } = diffQuestionNotifications(
      first.next,
      [draft('d-1', [])],
      undefined,
      new Map()
    );
    expect(notifications).toHaveLength(0);
  });

  // Run question ids are globally unique (server-minted), so a first sighting of
  // an id is the edge — no signature needed.
  test('notifies once for a newly seen run question', () => {
    const question: RunQuestion = {
      id: 'q-abc123',
      runId: 'r-1',
      question: 'Which branch?',
      options: [],
      askedAt: '2026-08-03T00:00:00.000Z',
      answer: null,
      answeredAt: null,
    };
    const first = diffQuestionNotifications(
      emptyQuestionTracking(),
      [],
      undefined,
      new Map()
    );
    const second = diffQuestionNotifications(
      first.next,
      [],
      undefined,
      new Map([['r-1', [question]]])
    );
    expect(second.notifications).toHaveLength(1);
    expect(second.notifications[0].target).toEqual({
      kind: 'run',
      runId: 'r-1',
    });
    const third = diffQuestionNotifications(
      second.next,
      [],
      undefined,
      new Map([['r-1', [question]]])
    );
    expect(third.notifications).toHaveLength(0);
  });

  test('a plan that gains questions notifies with a plan target', () => {
    const base: PlanRecord = {
      id: 'plan-1',
      prompt: 'build the thing',
      plannerName: 'claude',
      role: 'plan',
      state: 'ready',
      messages: [],
      questions: [],
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    const first = diffQuestionNotifications(
      emptyQuestionTracking(),
      [],
      base,
      new Map()
    );
    const { notifications } = diffQuestionNotifications(
      first.next,
      [],
      { ...base, questions: [Q1] },
      new Map()
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0].target).toEqual({ kind: 'plan', planId: 'plan-1' });
  });
});
