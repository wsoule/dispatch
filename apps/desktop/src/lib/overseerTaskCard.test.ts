import type { OverseerAction, RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  appliedTaskCard,
  isTaskTool,
  proposedTaskCard,
  taskCardHeading,
  taskCardNote,
} from './overseerTaskCard';

function run(over: Partial<RunMeta>): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-a',
    taskTitle: 'Schema',
    state: 'running',
    createdAt: '2026-11-01T10:00:00Z',
    ...over,
  } as RunMeta;
}

function action(tool: string, input: unknown): OverseerAction {
  return {
    id: 'act-1',
    tool,
    input,
    summary: 'summary',
    createdAt: '2026-11-01T09:00:00Z',
    status: 'pending',
  };
}

const titles: Record<string, string> = { 't-a': 'Schema', 't-b': 'UI' };
const taskTitle = (id: string) => titles[id];

describe('proposedTaskCard', () => {
  test("a plan proposes its tasks' titles, none started", () => {
    const card = proposedTaskCard(
      action('create_plan', {
        milestone: { title: 'Auth v2' },
        tasks: [{ title: 'Schema' }, { title: 'Endpoints' }, { title: 'UI' }],
      }),
      taskTitle,
      [run({})]
    );
    expect(card).toEqual({
      entries: [{ title: 'Schema' }, { title: 'Endpoints' }, { title: 'UI' }],
      proposed: 3,
      started: 0,
    });
  });

  test('one new task is one row', () => {
    const card = proposedTaskCard(
      action('create_task', { title: 'Spec the 403' }),
      taskTitle,
      []
    );
    expect(card?.proposed).toBe(1);
    expect(card?.entries[0]).toEqual({ title: 'Spec the 403' });
  });

  test('a dispatch names an existing task, with the run it already has', () => {
    const card = proposedTaskCard(
      action('dispatch_task', { taskId: 't-a' }),
      taskTitle,
      [run({ state: 'failed' })]
    );
    expect(card?.entries[0]).toMatchObject({
      taskId: 't-a',
      title: 'Schema',
      run: { state: 'failed' },
    });
    expect(card?.started).toBe(1);
  });

  test('other tools and malformed inputs have no card', () => {
    expect(proposedTaskCard(action('cancel_run', {}), taskTitle, [])).toBe(
      null
    );
    expect(
      proposedTaskCard(action('create_plan', { tasks: 'x' }), taskTitle, [])
    ).toBe(null);
    expect(proposedTaskCard(action('create_task', {}), taskTitle, [])).toBe(
      null
    );
    expect(isTaskTool('cancel_run')).toBe(false);
    expect(isTaskTool('create_plan')).toBe(true);
  });
});

describe('appliedTaskCard', () => {
  test("counts started tasks by each task's newest run", () => {
    const card = appliedTaskCard(['t-a', 't-b', 't-gone'], taskTitle, [
      run({ id: 'r-old', state: 'failed', createdAt: '2026-11-01T08:00:00Z' }),
      run({ id: 'r-new', state: 'running' }),
    ]);
    expect(card.proposed).toBe(3);
    expect(card.started).toBe(1);
    expect(card.entries[0].run?.id).toBe('r-new');
    expect(card.entries[1]).toEqual({ taskId: 't-b', title: 'UI' });
    // A task the board no longer lists keeps its id as its title.
    expect(card.entries[2].title).toBe('t-gone');
  });

  test('the head reads "N suggested tasks" and "K started"', () => {
    expect(taskCardHeading(1)).toBe('1 suggested task');
    expect(taskCardHeading(2)).toBe('2 suggested tasks');
    expect(taskCardNote(0)).toBe('0 started');
  });
});
