import type { PlannedTask, PlanRecord } from '@dispatch/client';
import { describe, expect, it } from 'bun:test';

import { enrichViewState } from './enrichReview.js';

function plannedTask(over: Partial<PlannedTask> = {}): PlannedTask {
  return {
    title: 'the timer leaks on unmount',
    description:
      'apps/desktop/src/hooks/useTicker.ts never clears its interval.',
    acceptanceCriteria: ['Unmounting the component clears the interval'],
    blockedByIndices: [],
    priority: 'medium',
    ...over,
  };
}

function planRecord(over: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: 'pl-1',
    prompt: 'add detail',
    plannerName: 'claude',
    role: 'enrich',
    state: 'ready',
    messages: [],
    proposal: { tasks: [plannedTask()] },
    questions: [],
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    ...over,
  };
}

describe('enrichViewState', () => {
  it('is idle before any plan has started', () => {
    expect(enrichViewState(undefined)).toEqual({ kind: 'idle' });
  });

  it('is running while the plan is in flight', () => {
    expect(
      enrichViewState(planRecord({ state: 'running', proposal: undefined }))
    ).toEqual({ kind: 'running' });
  });

  it('is ready with the drafted sections once the plan resolves', () => {
    expect(enrichViewState(planRecord())).toEqual({
      kind: 'ready',
      draft: {
        description:
          'apps/desktop/src/hooks/useTicker.ts never clears its interval.',
        acceptanceCriteria: ['Unmounting the component clears the interval'],
      },
    });
  });

  it('trims whitespace and drops blank criteria', () => {
    const state = enrichViewState(
      planRecord({
        proposal: {
          tasks: [
            plannedTask({
              description: '  spaced out  ',
              acceptanceCriteria: ['  keeps this  ', '   ', ''],
            }),
          ],
        },
      })
    );
    expect(state).toEqual({
      kind: 'ready',
      draft: { description: 'spaced out', acceptanceCriteria: ['keeps this'] },
    });
  });

  it('surfaces the planner error when the plan failed', () => {
    expect(
      enrichViewState(planRecord({ state: 'failed', error: 'boom' }))
    ).toEqual({ kind: 'failed', error: 'boom' });
  });

  it('still reports failure when a failed plan carries no message', () => {
    expect(enrichViewState(planRecord({ state: 'failed' }))).toEqual({
      kind: 'failed',
      error: 'the planner failed to draft any detail',
    });
  });

  // Otherwise the row's "Add detail" button would spin forever on a pass that finished with
  // nothing to review.
  it('reports failure for a ready record whose proposal has no tasks', () => {
    expect(enrichViewState(planRecord({ proposal: { tasks: [] } }))).toEqual({
      kind: 'failed',
      error: 'the planner came back with nothing to add',
    });
  });

  it('reports failure for a ready record whose one task is entirely blank', () => {
    expect(
      enrichViewState(
        planRecord({
          proposal: {
            tasks: [plannedTask({ description: '  ', acceptanceCriteria: [] })],
          },
        })
      )
    ).toEqual({
      kind: 'failed',
      error: 'the planner came back with nothing to add',
    });
  });

  it('reads only the first task when the planner proposed several', () => {
    const state = enrichViewState(
      planRecord({
        proposal: {
          tasks: [
            plannedTask({ description: 'first' }),
            plannedTask({ description: 'second' }),
          ],
        },
      })
    );
    expect(state.kind).toBe('ready');
    expect(state.kind === 'ready' && state.draft.description).toBe('first');
  });
});
