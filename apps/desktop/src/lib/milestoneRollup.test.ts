import type { TaskDoc } from '@dispatch/core/browser';
import { defaultTaskFields, statusModelOf } from '@dispatch/core/browser';
import { describe, expect, it } from 'bun:test';

import { isMilestoneFinished, rollupMilestoneStatus } from './milestoneRollup';
import { setActiveStatusModel } from './statusModel';

function task(status: string): TaskDoc {
  return {
    meta: {
      id: `t-${status}-${String(Math.abs(status.length))}`,
      title: status,
      status,
      kind: 'task',
      parent: 'e-1',
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'none',
      assignee: 'none',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      external: null,
      selfReview: false,
      writes: [],
      risk: 'routine',
      model: null,
      exercised: false,
      ...defaultTaskFields(),
    },
    body: '',
  };
}

describe('rollupMilestoneStatus', () => {
  it('is draft with no children', () => {
    expect(rollupMilestoneStatus([])).toBe('draft');
  });

  it('lands only when every child is terminal', () => {
    expect(rollupMilestoneStatus([task('landed'), task('dropped')])).toBe(
      'landed'
    );
    expect(rollupMilestoneStatus([task('landed'), task('ready')])).toBe(
      'ready'
    );
  });

  it('wears the most actionable open state', () => {
    expect(
      rollupMilestoneStatus([task('working'), task('review'), task('draft')])
    ).toBe('working');
    expect(rollupMilestoneStatus([task('review'), task('landing')])).toBe(
      'review'
    );
    expect(rollupMilestoneStatus([task('landing'), task('draft')])).toBe(
      'landing'
    );
    expect(rollupMilestoneStatus([task('ready'), task('draft')])).toBe('ready');
    expect(rollupMilestoneStatus([task('draft')])).toBe('draft');
  });

  it('terminal children never mask open ones', () => {
    expect(rollupMilestoneStatus([task('landed'), task('working')])).toBe(
      'working'
    );
  });

  it('counts a custom open status as open work at the ready tier', () => {
    expect(rollupMilestoneStatus([task('triage'), task('draft')])).toBe(
      'ready'
    );
  });
});

describe('isMilestoneFinished', () => {
  it('requires children and all-terminal', () => {
    expect(isMilestoneFinished([])).toBe(false);
    expect(isMilestoneFinished([task('landed')])).toBe(true);
    expect(isMilestoneFinished([task('landed'), task('working')])).toBe(false);
  });
});

describe('rollupMilestoneStatus under a mirrored workflow', () => {
  const linear = statusModelOf({
    statuses: [
      'Backlog',
      'Todo',
      'In Progress',
      'In Review',
      'Done',
      'Canceled',
    ],
    statusDefinitions: [
      { name: 'Backlog', type: 'backlog', color: null },
      { name: 'Todo', type: 'unstarted', color: null },
      { name: 'In Progress', type: 'started', color: null },
      { name: 'In Review', type: 'started', color: null },
      { name: 'Done', type: 'completed', color: null },
      { name: 'Canceled', type: 'canceled', color: null },
    ],
    statusRoles: {
      ready: 'Todo',
      dispatched: 'In Progress',
      review: 'In Review',
      landing: null,
      landed: 'Done',
      dropped: 'Canceled',
    },
  });

  it('rolls up by role and type, not by name', () => {
    setActiveStatusModel(linear);
    try {
      expect(rollupMilestoneStatus([task('Todo'), task('In Review')])).toBe(
        'In Review'
      );
      expect(rollupMilestoneStatus([task('Backlog')])).toBe('Backlog');
      expect(rollupMilestoneStatus([task('Done'), task('Canceled')])).toBe(
        'Done'
      );
      expect(isMilestoneFinished([task('Done'), task('Canceled')])).toBe(true);
    } finally {
      setActiveStatusModel(null);
    }
  });

  it('reads a passed model before the open project’s is set', () => {
    const done = [task('Done'), task('Canceled')];
    expect(rollupMilestoneStatus(done, linear)).toBe('Done');
    expect(isMilestoneFinished(done, linear)).toBe(true);
    // The built-in model has never heard of Done: open work at the ready tier.
    expect(rollupMilestoneStatus(done)).toBe('ready');
  });
});
