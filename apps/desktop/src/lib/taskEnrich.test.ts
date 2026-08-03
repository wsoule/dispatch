import type { PlannedTask, PlanRecord } from '@dispatch/client';
import { describe, expect, it } from 'bun:test';

import {
  enrichDraftFromPlan,
  enrichPatch,
  enrichPlanError,
} from './taskEnrich.js';

function plannedTask(over: Partial<PlannedTask> = {}): PlannedTask {
  return {
    title: 'inbox writes are not crash-safe',
    description: 'packages/server/src/inbox.ts rewrites the file in place.',
    acceptanceCriteria: ['A crash mid-write leaves the inbox parseable'],
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
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    ...over,
  };
}

describe('enrichDraftFromPlan', () => {
  it('reads the proposed sections off a ready plan', () => {
    expect(enrichDraftFromPlan(planRecord())).toEqual({
      description: 'packages/server/src/inbox.ts rewrites the file in place.',
      acceptanceCriteria: ['A crash mid-write leaves the inbox parseable'],
    });
  });

  it('has nothing to show while the plan is still running', () => {
    expect(
      enrichDraftFromPlan(planRecord({ state: 'running', proposal: undefined }))
    ).toBeNull();
  });

  it('has nothing to show for a failed plan', () => {
    expect(
      enrichDraftFromPlan(planRecord({ state: 'failed', error: 'boom' }))
    ).toBeNull();
  });

  it('has nothing to show before any plan has started', () => {
    expect(enrichDraftFromPlan(undefined)).toBeNull();
  });

  it('has nothing to show for a proposal with no tasks', () => {
    expect(enrichDraftFromPlan(planRecord({ proposal: { tasks: [] } }))).toBe(
      null
    );
  });

  // The prompt asks for exactly one task; a planner ignoring that shouldn't fan out.
  it('reads only the first task when the planner proposed several', () => {
    const draft = enrichDraftFromPlan(
      planRecord({
        proposal: {
          tasks: [
            plannedTask({ description: 'first' }),
            plannedTask({ description: 'second' }),
          ],
        },
      })
    );
    expect(draft?.description).toBe('first');
  });

  it('drops blank criteria and trims the rest', () => {
    const draft = enrichDraftFromPlan(
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
    expect(draft).toEqual({
      description: 'spaced out',
      acceptanceCriteria: ['keeps this'],
    });
  });

  it('has nothing to show when the proposal came back empty', () => {
    expect(
      enrichDraftFromPlan(
        planRecord({
          proposal: {
            tasks: [plannedTask({ description: '  ', acceptanceCriteria: [] })],
          },
        })
      )
    ).toBeNull();
  });
});

describe('enrichPlanError', () => {
  it('surfaces the planner error', () => {
    expect(
      enrichPlanError(planRecord({ state: 'failed', error: 'boom' }))
    ).toBe('boom');
  });

  it('still says something when a failed plan carries no message', () => {
    expect(enrichPlanError(planRecord({ state: 'failed' }))).toBe(
      'the planner failed to draft any detail'
    );
  });

  it('is quiet while running, and for a plan that has a draft', () => {
    expect(enrichPlanError(planRecord({ state: 'running' }))).toBeNull();
    expect(enrichPlanError(planRecord())).toBeNull();
    expect(enrichPlanError(undefined)).toBeNull();
  });

  // Otherwise the button spins forever on a pass that finished with nothing.
  it('reports a pass that finished with nothing to add', () => {
    expect(enrichPlanError(planRecord({ proposal: { tasks: [] } }))).toBe(
      'the planner came back with nothing to add'
    );
  });
});

describe('enrichPatch', () => {
  it('writes the description and the criteria as a bullet list', () => {
    expect(
      enrichPatch({
        description: 'the file is rewritten in place',
        acceptanceCriteria: ['parseable after a crash', 'covered by a test'],
      })
    ).toEqual({
      description: 'the file is rewritten in place',
      acceptanceCriteria: '- parseable after a crash\n- covered by a test',
    });
  });

  // Sections replace wholesale, so '' for an untouched section would delete a human's text.
  it('leaves criteria alone when the draft proposed none', () => {
    const patch = enrichPatch({
      description: 'just prose',
      acceptanceCriteria: [],
    });
    expect(patch).toEqual({ description: 'just prose' });
    expect('acceptanceCriteria' in patch).toBe(false);
  });

  it('leaves the description alone when the draft proposed none', () => {
    const patch = enrichPatch({
      description: '',
      acceptanceCriteria: ['only criteria'],
    });
    expect(patch).toEqual({ acceptanceCriteria: '- only criteria' });
    expect('description' in patch).toBe(false);
  });
});
