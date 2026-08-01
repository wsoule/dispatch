import type { DraftRecord } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { draftTrayViewModel, formatElapsed } from './draftTray';

// Builds a minimal DraftRecord — only the tray-relevant fields vary per test.
function draft(overrides: Partial<DraftRecord>): DraftRecord {
  return {
    id: 'draft-1',
    prompt: 'add a retry button',
    state: 'running',
    message: '',
    proposal: null,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const READY_PROPOSAL = {
  tasks: [
    {
      title: 'Add a retry button',
      description: 'desc',
      acceptanceCriteria: [],
      blockedByIndices: [],
      priority: 'none' as const,
    },
  ],
};

describe('formatElapsed', () => {
  test('formats seconds, minutes, and hours', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatElapsed(60_000)).toBe('1m');
    expect(formatElapsed(3 * 60_000 + 30_000)).toBe('3m');
    expect(formatElapsed(60 * 60_000)).toBe('1h');
    expect(formatElapsed(2 * 60 * 60_000 + 30 * 60_000)).toBe('2h');
  });

  test('clamps a negative duration to zero rather than printing a negative number', () => {
    expect(formatElapsed(-500)).toBe('0s');
  });
});

describe('draftTrayViewModel', () => {
  test('orders running first, then ready newest first, then failed', () => {
    const drafts = [
      draft({
        id: 'ready-old',
        state: 'ready',
        proposal: READY_PROPOSAL,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      draft({ id: 'failed-1', state: 'failed', error: 'boom' }),
      draft({
        id: 'running-1',
        state: 'running',
        createdAt: '2026-01-01T00:02:00.000Z',
      }),
      draft({
        id: 'ready-new',
        state: 'ready',
        proposal: READY_PROPOSAL,
        createdAt: '2026-01-01T00:03:00.000Z',
      }),
    ];

    const { items } = draftTrayViewModel(drafts, Date.now());

    expect(items.map((i) => i.id)).toEqual([
      'running-1',
      'ready-new',
      'ready-old',
      'failed-1',
    ]);
  });

  test('badge count includes running and ready, excludes failed', () => {
    const drafts = [
      draft({ id: 'r1', state: 'running' }),
      draft({ id: 'r2', state: 'ready', proposal: READY_PROPOSAL }),
      draft({ id: 'r3', state: 'failed', error: 'boom' }),
    ];

    expect(draftTrayViewModel(drafts).badgeCount).toBe(2);
  });

  test('badge count is zero once every draft has settled failed (a dismissed draft is simply absent from the list)', () => {
    const drafts = [draft({ id: 'r1', state: 'failed', error: 'boom' })];
    expect(draftTrayViewModel(drafts).badgeCount).toBe(0);
  });

  test('hasRunning is true only while at least one draft is running', () => {
    expect(
      draftTrayViewModel([draft({ id: 'r1', state: 'running' })]).hasRunning
    ).toBe(true);
    expect(
      draftTrayViewModel([
        draft({ id: 'r1', state: 'ready', proposal: READY_PROPOSAL }),
        draft({ id: 'r2', state: 'failed', error: 'boom' }),
      ]).hasRunning
    ).toBe(false);
    expect(draftTrayViewModel([]).hasRunning).toBe(false);
  });

  test('label prefers the proposal title when ready, the error when failed, and the prompt while running', () => {
    const drafts = [
      draft({ id: 'running', state: 'running', prompt: 'add retries' }),
      draft({ id: 'ready', state: 'ready', proposal: READY_PROPOSAL }),
      draft({ id: 'failed', state: 'failed', error: 'planner timed out' }),
    ];

    const byId = new Map(
      draftTrayViewModel(drafts).items.map((i) => [i.id, i])
    );
    expect(byId.get('running')?.label).toBe('add retries');
    expect(byId.get('ready')?.label).toBe('Add a retry button');
    expect(byId.get('failed')?.label).toBe('planner timed out');
  });

  test('elapsed is computed against the supplied `now`, not the real clock', () => {
    const drafts = [draft({ id: 'r1', createdAt: '2026-01-01T00:00:00.000Z' })];
    const now = new Date('2026-01-01T00:01:30.000Z').getTime();
    expect(draftTrayViewModel(drafts, now).items[0]?.elapsed).toBe('1m');
  });

  test('taskCount is null until the proposal settles, then reflects its task count', () => {
    const running = draftTrayViewModel([draft({ state: 'running' })]).items[0];
    expect(running?.taskCount).toBeNull();

    const ready = draftTrayViewModel([
      draft({
        state: 'ready',
        proposal: { tasks: [...READY_PROPOSAL.tasks, ...READY_PROPOSAL.tasks] },
      }),
    ]).items[0];
    expect(ready?.taskCount).toBe(2);
  });
});
