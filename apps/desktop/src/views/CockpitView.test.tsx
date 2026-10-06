import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { RunMeta } from '@dispatch/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

import type { DispatchProjectData } from '../hooks/useDispatchProject';

// The split pane mounts the task page, whose Review mode pulls in the Pierre diff; its
// worker import only Vite resolves.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
}));

const { CockpitView } = await import('./CockpitView');

const ME = 'human:wyat';

beforeEach(() => window.localStorage.clear());

function task(
  id: string,
  overrides: Partial<TaskListItem['meta']> = {}
): TaskListItem {
  return {
    meta: {
      id,
      title: `Title ${id}`,
      status: 'ready',
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'medium',
      assignee: ME,
      created: `2026-09-0${id.slice(-1)}T00:00:00.000Z`,
      updated: '2026-09-10T00:00:00.000Z',
      dueDate: null,
      cycle: null,
      ...overrides,
    },
  } as TaskListItem;
}

const LIVE: RunMeta = {
  id: 'r-live',
  taskId: 't-9',
  taskTitle: 'Title t-9',
  executor: 'claude',
  state: 'running',
  branch: 'b',
  baseBranch: 'main',
  worktreePath: '/tmp',
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
  dispatchedBy: ME,
};

function dataWith(
  tasks: TaskListItem[],
  runs: RunMeta[] = []
): DispatchProjectData {
  return {
    client: {},
    port: 1,
    portLoading: false,
    portError: false,
    config: null,
    me: ME,
    people: [],
    tasks,
    tasksIncludingArchived: tasks,
    tasksReady: true,
    runs,
    latestRunByTaskId: new Map(runs.map((r) => [r.taskId, r])),
    liveRunStateByTaskId: new Map(runs.map((r) => [r.taskId, r.state])),
    attentionByTaskId: new Map(),
    liveEpicSessions: [],
    readinessById: new Map(),
    retryEnsureDispatchd: () => {},
  } as unknown as DispatchProjectData;
}

interface Calls {
  opened: string[];
  peeked: string[];
  failed: [string, string][];
}

function mount(
  data: DispatchProjectData,
  dispatchTask: (taskId: string) => Promise<void> = () => Promise.resolve()
) {
  const calls: Calls = { opened: [], peeked: [], failed: [] };
  const view = (d: DispatchProjectData) => (
    <CockpitView
      data={d}
      projectName="demo"
      dispatchTask={dispatchTask}
      onDispatchFailed={(id, message) => calls.failed.push([id, message])}
      onOpenTask={(id) => calls.opened.push(id)}
      onPeekTask={(id) => calls.peeked.push(id)}
    />
  );
  const result = render(view(data));
  return {
    ...result,
    calls,
    rerenderWith: (d: DispatchProjectData) => result.rerender(view(d)),
  };
}

const grid = () => screen.getByRole('grid', { name: 'Home' });
const laneKeys = (lane: string) =>
  Array.from(
    document.querySelectorAll(`[data-lane=${lane}] [data-row-key]`)
  ).map((row) => row.getAttribute('data-row-key'));
const press = (key: string) => fireEvent.keyDown(grid(), { key });

describe('CockpitView', () => {
  test('draws the three lanes from the cached lists', () => {
    mount(
      dataWith(
        [task('t-1'), task('t-2'), task('t-9', { status: 'working' })],
        [LIVE]
      )
    );
    expect(
      Array.from(
        document.querySelectorAll('[data-lane] [data-slot=group-header-name]')
      ).map((name) => name.textContent)
    ).toEqual(['Ready for you', 'In flight', 'Needs you']);
    expect(laneKeys('ready')).toEqual(['t-1', 't-2']);
    expect(laneKeys('flight')).toEqual(['run:r-live']);
  });

  test('j/k move the cursor and h/l change lanes', () => {
    mount(
      dataWith(
        [task('t-1'), task('t-2'), task('t-9', { status: 'working' })],
        [LIVE]
      )
    );
    expect(grid().getAttribute('aria-activedescendant')).toBe(
      'cockpit-row-t-1'
    );
    press('j');
    expect(grid().getAttribute('aria-activedescendant')).toBe(
      'cockpit-row-t-2'
    );
    press('l');
    expect(grid().getAttribute('aria-activedescendant')).toBe(
      'cockpit-row-run-r-live'
    );
    press('h');
    press('k');
    expect(grid().getAttribute('aria-activedescendant')).toBe(
      'cockpit-row-t-1'
    );
  });

  test('d moves the task into flight at once', () => {
    mount(dataWith([task('t-1'), task('t-2')]), () => new Promise(() => {}));
    press('d');
    expect(laneKeys('ready')).toEqual(['t-2']);
    expect(laneKeys('flight')).toEqual(['starting:t-1']);
    // The cursor stays in Ready, on the row that took the dispatched one's place.
    expect(grid().getAttribute('aria-activedescendant')).toBe(
      'cockpit-row-t-2'
    );
  });

  test('a refused dispatch puts the task back in Ready and reports it', async () => {
    let reject: (err: Error) => void = () => {};
    const { calls } = mount(
      dataWith([task('t-1'), task('t-2')]),
      () =>
        new Promise<void>((_, r) => {
          reject = r;
        })
    );
    press('d');
    expect(laneKeys('flight')).toEqual(['starting:t-1']);
    await act(async () => {
      reject(new Error('blocked by t-0'));
      await Promise.resolve();
    });
    expect(laneKeys('ready')).toEqual(['t-1', 't-2']);
    expect(laneKeys('flight')).toEqual([]);
    expect(calls.failed).toEqual([['t-1', 'blocked by t-0']]);
  });

  test('Enter opens the split: the other lanes fold to strips', () => {
    mount(dataWith([task('t-1'), task('t-9', { status: 'working' })], [LIVE]));
    press('Enter');
    expect(screen.getByRole('button', { name: 'In flight, 1' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Needs you, 0' })).not.toBeNull();
    press('Escape');
    expect(screen.queryByRole('button', { name: 'In flight, 1' })).toBeNull();
  });

  test('o opens the full page, Space the peek', () => {
    const { calls } = mount(dataWith([task('t-1')]));
    press('o');
    press(' ');
    expect(calls.opened).toEqual(['t-1']);
    expect(calls.peeked).toEqual(['t-1']);
  });

  test('t flips to the team, and g p groups by person', () => {
    mount(dataWith([task('t-1'), task('t-2', { assignee: 'human:maya' })]));
    expect(laneKeys('ready')).toEqual(['t-1']);
    press('t');
    expect(laneKeys('ready')).toEqual(['t-1', 't-2']);
    press('g');
    press('p');
    expect(document.querySelectorAll('[data-slot=roster-header]')).toHaveLength(
      2
    );
  });

  test('a fan-out row opens its container’s full Flight Plan', () => {
    const data = {
      ...dataWith([
        task('e-1', { kind: 'milestone', status: 'working' }),
        task('t-1', { parent: 'e-1' }),
      ]),
      liveEpicSessions: [
        {
          epicId: 'e-1',
          active: true,
          session: { epicId: 'e-1', concurrency: 2, state: 'active' },
          spend: {},
          children: [],
          waves: [],
          liveRuns: [],
        },
      ],
    } as unknown as DispatchProjectData;
    const { calls } = mount(data);
    fireEvent.click(document.querySelector('[data-row-key="fanout:e-1"]'));
    expect(calls.opened).toEqual(['e-1']);
    // Enter on the row opens the plan too, never the split pane.
    press('Enter');
    expect(calls.opened).toEqual(['e-1', 'e-1']);
    expect(
      screen.queryByRole('button', { name: 'Ready for you, 1' })
    ).toBeNull();
  });

  test('an agent’s task the merge queue is landing sits in flight and opens its review', () => {
    const finished: RunMeta = {
      ...LIVE,
      id: 'r-5',
      taskId: 't-5',
      taskTitle: 'Title t-5',
      state: 'finished',
      reviewedAt: '2026-09-20T00:30:00.000Z',
    };
    const data = {
      ...dataWith(
        [task('t-5', { status: 'landing', assignee: 'agent' })],
        [finished]
      ),
      mergeQueue: {
        entries: [
          {
            runId: 'r-5',
            taskId: 't-5',
            taskTitle: 'Title t-5',
            state: 'verifying',
            enqueuedAt: '2026-09-20T01:00:00.000Z',
          },
        ],
        history: [],
      },
    } as unknown as DispatchProjectData;
    const opened: unknown[][] = [];
    render(
      <CockpitView
        data={data}
        projectName="demo"
        dispatchTask={() => Promise.resolve()}
        onDispatchFailed={() => {}}
        onOpenTask={(...args) => opened.push(args)}
        onPeekTask={() => {}}
      />
    );
    expect(laneKeys('flight')).toEqual(['landing:t-5']);
    expect(
      document
        .querySelector('[data-lane=flight] [data-slot=landing-badge]')
        ?.getAttribute('title')
    ).toBe('Landing · verifying');
    press('l');
    press('o');
    expect(opened).toEqual([['t-5', 'review', 'r-5']]);
  });
});
