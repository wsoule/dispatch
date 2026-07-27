import type {
  PlannedTask,
  PlanProposal,
  PlanRecord,
  PlanState,
} from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  buildPlanThread,
  editPlanDraft,
  proposalsEqual,
  syncPlanDraft,
} from './planThread';

function makeTask(
  title: string,
  patch: Partial<PlannedTask> = {}
): PlannedTask {
  return {
    title,
    description: `${title} description`,
    acceptanceCriteria: [],
    blockedByIndices: [],
    priority: 'medium',
    ...patch,
  };
}

function makeRecord(patch: Partial<PlanRecord> = {}): PlanRecord {
  const state: PlanState = patch.state ?? 'ready';
  return {
    id: 'plan-abc123',
    prompt: 'Add search',
    plannerName: 'claude',
    state,
    messages: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    ...patch,
  };
}

describe('buildPlanThread', () => {
  test('returns nothing until the plan record has loaded', () => {
    expect(buildPlanThread(undefined)).toEqual([]);
  });

  test('renders the transcript in order with stable per-message keys', () => {
    const items = buildPlanThread(
      makeRecord({
        messages: [
          { role: 'user', text: 'Add search', at: '2026-01-01T00:00:00.000Z' },
          {
            role: 'assistant',
            text: 'Here are four tasks',
            at: '2026-01-01T00:00:30.000Z',
          },
        ],
      })
    );

    expect(items).toEqual([
      {
        kind: 'message',
        key: 'plan-abc123-msg-0',
        role: 'user',
        text: 'Add search',
        at: '2026-01-01T00:00:00.000Z',
      },
      {
        kind: 'message',
        key: 'plan-abc123-msg-1',
        role: 'assistant',
        text: 'Here are four tasks',
        at: '2026-01-01T00:00:30.000Z',
      },
    ]);
  });

  test('appends a pending row while a turn is in flight', () => {
    const items = buildPlanThread(
      makeRecord({
        state: 'running',
        messages: [
          {
            role: 'user',
            text: 'Split task 2',
            at: '2026-01-01T00:01:00.000Z',
          },
        ],
      })
    );

    expect(items.map((item) => item.kind)).toEqual(['message', 'pending']);
  });

  test('appends the server error as a failed row', () => {
    const items = buildPlanThread(
      makeRecord({
        state: 'failed',
        error: 'planner exited with code 1',
        messages: [
          {
            role: 'user',
            text: 'Split task 2',
            at: '2026-01-01T00:01:00.000Z',
          },
        ],
      })
    );

    expect(items[1]).toEqual({
      kind: 'failed',
      key: 'plan-abc123-failed',
      error: 'planner exited with code 1',
    });
  });

  test('falls back to actionable copy when a failed turn carries no error', () => {
    const [item] = buildPlanThread(makeRecord({ state: 'failed', error: '' }));

    expect(item).toMatchObject({ kind: 'failed' });
    expect(item.kind === 'failed' && item.error).toContain('Send the message');
  });
});

describe('syncPlanDraft', () => {
  const proposal: PlanProposal = {
    epic: { title: 'Search', description: 'Make things findable' },
    tasks: [makeTask('Index documents'), makeTask('Add a search box')],
  };

  test('seeds a draft with one stable key per task', () => {
    const draft = syncPlanDraft(null, proposal, 'plan-abc123');

    expect(draft.proposal).toBe(proposal);
    expect(draft.base).toBe(proposal);
    expect(draft.revision).toBe(0);
    expect(draft.taskKeys).toEqual([
      'plan-task-plan-abc123-r0-0',
      'plan-task-plan-abc123-r0-1',
    ]);
  });

  test('keeps local edits when a poll returns the same proposal again', () => {
    const seeded = syncPlanDraft(null, proposal, 'plan-abc123');
    const edited = editPlanDraft(seeded, {
      type: 'setTaskTitle',
      index: 0,
      title: 'Index every document',
    });

    // A refetch hands back a structurally identical (but not reference-equal)
    // proposal — the edited draft must survive it untouched.
    const refetched: PlanProposal = JSON.parse(
      JSON.stringify(proposal)
    ) as PlanProposal;
    expect(syncPlanDraft(edited, refetched, 'plan-abc123')).toBe(edited);
  });

  test('adopts a refined proposal from a later turn and mints fresh keys', () => {
    const seeded = syncPlanDraft(null, proposal, 'plan-abc123');
    const refined: PlanProposal = {
      ...proposal,
      tasks: [...proposal.tasks, makeTask('Rank results')],
    };

    const next = syncPlanDraft(seeded, refined, 'plan-abc123');

    expect(next.proposal).toBe(refined);
    expect(next.revision).toBe(1);
    expect(next.taskKeys).toEqual([
      'plan-task-plan-abc123-r1-0',
      'plan-task-plan-abc123-r1-1',
      'plan-task-plan-abc123-r1-2',
    ]);
    // No key from the previous revision survives into the new row set.
    expect(
      next.taskKeys.some((key) => seeded.taskKeys.includes(key))
    ).toBeFalse();
  });

  test('re-seeds from scratch when the open plan changes', () => {
    const seeded = syncPlanDraft(null, proposal, 'plan-abc123');

    const other = syncPlanDraft(seeded, proposal, 'plan-def456');

    expect(other.planId).toBe('plan-def456');
    expect(other.revision).toBe(0);
    expect(other.taskKeys[0]).toBe('plan-task-plan-def456-r0-0');
  });
});

describe('editPlanDraft', () => {
  const draft = syncPlanDraft(
    null,
    {
      tasks: [
        makeTask('A'),
        makeTask('B'),
        makeTask('C', { blockedByIndices: [1] }),
      ],
    },
    'plan-abc123'
  );

  test('keeps taskKeys in lockstep when a row is removed', () => {
    const next = editPlanDraft(draft, { type: 'removeTask', index: 1 });

    expect(next.proposal.tasks.map((t) => t.title)).toEqual(['A', 'C']);
    expect(next.taskKeys).toEqual([
      'plan-task-plan-abc123-r0-0',
      'plan-task-plan-abc123-r0-2',
    ]);
    // The surviving dependency pointed at the removed row, so it's dropped.
    expect(next.proposal.tasks[1].blockedByIndices).toEqual([]);
  });

  test('leaves the server baseline alone so later turns still compare cleanly', () => {
    const next = editPlanDraft(draft, {
      type: 'setTaskPriority',
      index: 0,
      priority: 'urgent',
    });

    expect(next.base).toBe(draft.base);
    expect(next.taskKeys).toBe(draft.taskKeys);
    expect(proposalsEqual(next.proposal, next.base)).toBeFalse();
  });

  test('returns the same draft when the edit is a no-op', () => {
    // `setEpicTitle` on a proposal with no epic is the reducer's one no-op.
    expect(editPlanDraft(draft, { type: 'setEpicTitle', title: 'x' })).toBe(
      draft
    );
  });
});

describe('proposalsEqual', () => {
  test('ignores key order but catches every field the review list renders', () => {
    const base: PlanProposal = {
      epic: { title: 'Search', description: 'Findable' },
      tasks: [
        makeTask('Index', {
          acceptanceCriteria: ['docs indexed'],
          blockedByIndices: [],
        }),
      ],
    };

    expect(
      proposalsEqual(base, JSON.parse(JSON.stringify(base)) as PlanProposal)
    ).toBeTrue();
    expect(
      proposalsEqual(base, {
        ...base,
        epic: { title: 'Search', description: 'Findable fast' },
      })
    ).toBeFalse();
    expect(
      proposalsEqual(base, {
        ...base,
        tasks: [makeTask('Index', { acceptanceCriteria: ['docs indexed!'] })],
      })
    ).toBeFalse();
    expect(proposalsEqual(base, { tasks: base.tasks })).toBeFalse();
  });
});
