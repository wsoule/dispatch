import type { TaskDoc } from '@dispatch/core/browser';
import { describe, expect, it } from 'bun:test';

import { isMilestoneFinished, rollupMilestoneStatus } from './milestoneRollup';

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
