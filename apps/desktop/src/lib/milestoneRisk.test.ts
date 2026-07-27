import type { RunMeta } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core';
import { describe, expect, test } from 'bun:test';

import { deriveMilestoneStatus } from './milestoneRisk';

function task(id: string): TaskDoc {
  return { meta: { id, title: id } } as TaskDoc;
}

function run(taskId: string, over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: `r-${taskId}`,
    taskId,
    taskTitle: taskId,
    executor: 'claude',
    state: 'running',
    branch: 'b',
    baseBranch: 'main',
    worktreePath: '/tmp',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...over,
  } as RunMeta;
}

function runs(...entries: RunMeta[]): Map<string, RunMeta> {
  return new Map(entries.map((r) => [r.taskId, r]));
}

const three = [task('t-1'), task('t-2'), task('t-3')];

describe('deriveMilestoneStatus', () => {
  test('an all-closed milestone is complete, not stalled', () => {
    const s = deriveMilestoneStatus(three, runs(), true);
    expect(s.health).toBe('complete');
    expect(s.reason).toBeNull();
  });

  test('agents running with nothing stuck reads as in progress', () => {
    const s = deriveMilestoneStatus(three, runs(run('t-1')), false);
    expect(s.health).toBe('active');
    expect(s.working).toBe(1);
    expect(s.reason).toBeNull();
  });

  test('no runs at all reads as not started', () => {
    expect(deriveMilestoneStatus(three, runs(), false).health).toBe('idle');
  });

  test('a frozen approval stalls the milestone and says so specifically', () => {
    const s = deriveMilestoneStatus(
      three,
      runs(run('t-1', { state: 'awaiting-approval' })),
      false
    );
    expect(s.health).toBe('stalled');
    expect(s.reason).toBe('1 task is frozen waiting on you.');
  });

  test('the reason pluralises', () => {
    const s = deriveMilestoneStatus(
      three,
      runs(
        run('t-1', { state: 'awaiting-approval' }),
        run('t-2', { state: 'awaiting-approval' })
      ),
      false
    );
    expect(s.reason).toBe('2 tasks are frozen waiting on you.');
  });

  // Waiting and failing call for different actions, so a milestone with both must not collapse
  // them into one number and hide half the work.
  test('both causes are named when both are present', () => {
    const s = deriveMilestoneStatus(
      three,
      runs(
        run('t-1', { state: 'awaiting-approval' }),
        run('t-2', { state: 'failed' })
      ),
      false
    );
    expect(s.reason).toContain('frozen waiting on you');
    expect(s.reason).toContain('failed');
    expect(s.waiting).toBe(1);
    expect(s.failed).toBe(1);
  });

  // Being stalled outranks being busy: one frozen task is the thing to act on even if three
  // others are happily running.
  test('a stall outranks concurrent progress', () => {
    const s = deriveMilestoneStatus(
      three,
      runs(run('t-1'), run('t-2'), run('t-3', { state: 'awaiting-approval' })),
      false
    );
    expect(s.health).toBe('stalled');
    expect(s.working).toBe(2);
  });

  test('a closed-out run does not count towards anything', () => {
    const s = deriveMilestoneStatus(
      three,
      runs(
        run('t-1', {
          state: 'finished',
          reviewedAt: '2026-07-26T01:00:00.000Z',
        })
      ),
      false
    );
    expect(s.health).toBe('idle');
    expect(s.working).toBe(0);
  });

  test('tasks with no run are simply skipped', () => {
    const s = deriveMilestoneStatus(three, runs(run('t-2')), false);
    expect(s.working).toBe(1);
  });
});
