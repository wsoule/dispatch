import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { EpicProgress, RunMeta } from '@dispatch/client';
import { renderHook } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import { taskDoc } from '../lib/taskDoc.test-helper';
import {
  milestoneDetailOf,
  type PlanningInput,
  PlanningProvider,
  usePlanning,
  usePlanningContext,
} from './usePlanning';

function tasks(): TaskListItem[] {
  return [
    taskDoc({
      id: 'proj-1',
      title: 'Storefront',
      kind: 'project',
      status: 'working',
      assignee: 'human:ana',
    }),
    taskDoc({
      id: 'ms-1',
      title: 'Beta',
      kind: 'milestone',
      parent: 'proj-1',
      dueDate: '2099-01-01',
    }),
    taskDoc({
      id: 't-1',
      title: 'Persist the cart',
      parent: 'ms-1',
      status: 'working',
    }),
  ];
}

function input(over: Partial<PlanningInput> = {}): PlanningInput {
  return {
    tasks: tasks(),
    config: null,
    people: [{ ref: 'human:ana', name: 'Ana' }],
    executors: {
      executors: [
        {
          name: 'claude',
          reportsCost: true,
          reportsTurns: true,
          enforcesCaps: true,
        },
      ],
      default: 'claude',
    },
    me: 'human:wyat',
    linearLinks: {},
    latestRunByTaskId: new Map<string, RunMeta>(),
    epicProgressById: new Map<string, EpicProgress>(),
    ...over,
  };
}

describe('usePlanning', () => {
  test('runs the chain over the project data', () => {
    const { result } = renderHook(
      (props: PlanningInput) => usePlanning(props),
      {
        initialProps: input(),
      }
    );
    const planning = result.current;
    expect(planning.workspace.issues.map((issue) => issue.id)).toEqual(['t-1']);
    expect(planning.workspace.users.map((user) => user.id)).toEqual([
      'human:ana',
      'agent:wyat/claude',
      'agent',
    ]);
    expect(planning.snapshot.projects.has('proj-1')).toBe(true);
    expect(planning.assessments.get('ms-1')?.status).toBe('on_track');
    expect(planning.allocation.projects[0]?.projectId).toBe('proj-1');
    expect(planning.timeline.groups[0]?.lanes[0]?.name).toBe('Storefront');
    expect(planning.timeline.groups[0]?.lanes[0]?.leadName).toBe('Ana');
    expect(planning.milestoneGraph.nodes.map((node) => node.id)).toEqual([
      'ms-1',
    ]);
    // Today is the local calendar day, read within the last minute.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(planning.ctx.today).toBe(
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    );
    expect(now.getTime() - Date.parse(planning.ctx.now)).toBeLessThan(60_000);
    expect(planning.ctx.meta.size).toBe(0);
  });

  test('keeps its identity across re-renders with the same inputs', () => {
    const first = input();
    const { result, rerender } = renderHook(
      (props: PlanningInput) => usePlanning(props),
      { initialProps: first }
    );
    const before = result.current;
    // The same objects again (what useDispatchProject hands a stable list).
    rerender({ ...first });
    expect(result.current).toBe(before);
    expect(result.current.timeline).toBe(before.timeline);
  });

  test('a run event that moves no latest run start recomputes nothing', () => {
    const run = (createdAt: string, updatedAt: string): RunMeta =>
      ({
        id: 'r-1',
        taskId: 't-1',
        createdAt,
        updatedAt,
      }) as unknown as RunMeta;
    const first = input({
      latestRunByTaskId: new Map([
        ['t-1', run('2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z')],
      ]),
    });
    const { result, rerender } = renderHook(
      (props: PlanningInput) => usePlanning(props),
      { initialProps: first }
    );
    const before = result.current;
    expect(before.workspace.issues[0]?.startedAt).toBe(
      '2026-10-20T10:00:00.000Z'
    );
    // A new Map (the run progressed) with the same start.
    rerender({
      ...first,
      latestRunByTaskId: new Map([
        ['t-1', run('2026-10-20T10:00:00.000Z', '2026-10-20T10:05:00.000Z')],
      ]),
    });
    expect(result.current).toBe(before);
    // A new run started: the plan moves.
    rerender({
      ...first,
      latestRunByTaskId: new Map([
        ['t-1', run('2026-10-21T10:00:00.000Z', '2026-10-21T10:00:00.000Z')],
      ]),
    });
    expect(result.current).not.toBe(before);
    expect(result.current.workspace.issues[0]?.startedAt).toBe(
      '2026-10-21T10:00:00.000Z'
    );
  });

  test('a fan-out progress refetch that moves no session state recomputes nothing', () => {
    const progress = (
      state: 'active' | 'paused',
      completed: number
    ): EpicProgress =>
      ({
        epicId: 'proj-1',
        session: { state },
        completed,
      }) as unknown as EpicProgress;
    const first = input({
      epicProgressById: new Map([['proj-1', progress('active', 1)]]),
    });
    const { result, rerender } = renderHook(
      (props: PlanningInput) => usePlanning(props),
      { initialProps: first }
    );
    const before = result.current;
    expect(before.workspace.projects[0]?.statusType).toBe('started');
    // A new Map (a count moved) with the same session state.
    rerender({
      ...first,
      epicProgressById: new Map([['proj-1', progress('active', 2)]]),
    });
    expect(result.current).toBe(before);
    // The session paused: the project is paused, so the plan moves.
    rerender({
      ...first,
      epicProgressById: new Map([['proj-1', progress('paused', 2)]]),
    });
    expect(result.current).not.toBe(before);
    expect(result.current.workspace.projects[0]?.statusType).toBe('paused');
  });

  test('graph(scope) builds a scope once per planning and shares the milestone level', () => {
    const first = input();
    const { result, rerender } = renderHook(
      (props: PlanningInput) => usePlanning(props),
      { initialProps: first }
    );
    const planning = result.current;
    // The same scope, however its keys are written, is the same object.
    const inProject = planning.graph({ level: 'issue', projectId: 'proj-1' });
    expect(inProject.nodes.map((node) => node.id)).toEqual(['t-1']);
    expect(planning.graph({ projectId: 'proj-1', level: 'issue' })).toBe(
      inProject
    );
    expect(planning.graph({ level: 'milestone' })).toBe(
      planning.milestoneGraph
    );
    // Another scope is another graph.
    expect(planning.graph({ level: 'project' }).nodes.map((n) => n.id)).toEqual(
      ['proj-1']
    );
    // A re-render with the same inputs keeps the graphs; a change starts over.
    rerender({ ...first });
    expect(result.current.graph({ level: 'issue', projectId: 'proj-1' })).toBe(
      inProject
    );
    rerender({
      ...first,
      tasks: [
        ...first.tasks,
        taskDoc({ id: 't-2', title: 'Another', parent: 'ms-1' }),
      ],
    });
    const rebuilt = result.current.graph({
      level: 'issue',
      projectId: 'proj-1',
    });
    expect(rebuilt).not.toBe(inProject);
    expect(rebuilt.nodes.map((node) => node.id)).toEqual(['t-1', 't-2']);
  });

  test('changes when the tasks change', () => {
    const first = input();
    const { result, rerender } = renderHook(
      (props: PlanningInput) => usePlanning(props),
      { initialProps: first }
    );
    const before = result.current;
    rerender({
      ...first,
      tasks: [
        ...first.tasks,
        taskDoc({ id: 't-2', title: 'Another', parent: 'ms-1' }),
      ],
    });
    const after = result.current;
    expect(after).not.toBe(before);
    expect(after.workspace.issues.map((issue) => issue.id)).toEqual([
      't-1',
      't-2',
    ]);
    expect(after.assessments.get('ms-1')?.progress.total).toBe(2);
  });

  test('changes when the people or the executors change', () => {
    const first = input();
    const { result, rerender } = renderHook(
      (props: PlanningInput) => usePlanning(props),
      { initialProps: first }
    );
    const before = result.current;
    rerender({ ...first, people: [] });
    const noPeople = result.current;
    expect(noPeople).not.toBe(before);
    // Ana is no longer a user, so the project has no lead.
    expect(noPeople.timeline.banners.projectsWithoutLead).toEqual([
      { projectId: 'proj-1', name: 'Storefront' },
    ]);
    rerender({ ...first, people: [], executors: null });
    expect(result.current).not.toBe(noPeople);
    expect(result.current.workspace.users.map((user) => user.id)).toEqual([
      'agent',
    ]);
  });
});

describe('milestoneDetailOf and PlanningContext', () => {
  test('the selector details a milestone and nothing else', () => {
    const { result } = renderHook(() => usePlanning(input()));
    const detail = milestoneDetailOf(result.current, 'ms-1');
    expect(detail?.milestone.name).toBe('Beta');
    expect(detail?.leadName).toBe('Ana');
    expect(detail?.issues.map((issue) => issue.issueId)).toEqual(['t-1']);
    expect(milestoneDetailOf(result.current, 't-1')).toBeNull();
    expect(milestoneDetailOf(result.current, 'proj-1')).toBeNull();
  });

  test('the provider hands the planning to the surfaces under it; none outside', () => {
    const inside = renderHook(() => usePlanningContext(), {
      wrapper: ({ children }) => (
        <PlanningProvider data={input()}>{children}</PlanningProvider>
      ),
    });
    expect(inside.result.current?.assessments.get('ms-1')?.status).toBe(
      'on_track'
    );
    const outside = renderHook(() => usePlanningContext());
    expect(outside.result.current).toBeNull();
  });
});
