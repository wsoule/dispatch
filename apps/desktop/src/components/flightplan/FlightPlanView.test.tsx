import type { EpicProgress, RunMeta } from '@dispatch/client';
import type { TaskListItem } from '@dispatch/core/browser';
import { statusModelOf } from '@dispatch/core/browser';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { type ReactNode, useEffect } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { setActiveStatusModel } from '../../lib/statusModel';
import { testConfig } from '../settings/fixtures.test-helper';

// The split pane mounts the task page, whose Review mode pulls in the Pierre diff; its
// worker import only Vite resolves.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
}));

const { ContainerFlightPlanSection, FlightPlanHostContext } =
  await import('./ContainerFlightPlanSection');
const { FlightPlan } = await import('./FlightPlanView');

beforeEach(() => window.localStorage.clear());
// Unmount before resetting, so the reset does not redraw a mounted plan outside act.
afterEach(() => {
  cleanup();
  setActiveStatusModel(null);
});

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
      parent: 'e-1',
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'medium',
      assignee: 'none',
      risk: 'routine',
      writes: ['src/x.ts'],
      external: null,
      created: `2026-09-01T00:00:0${id.slice(-1)}.000Z`,
      updated: '2026-09-10T00:00:00.000Z',
      dueDate: null,
      ...overrides,
    },
  } as TaskListItem;
}

const LIVE: RunMeta = {
  id: 'r-b',
  taskId: 't-b',
  taskTitle: 'Title t-b',
  executor: 'claude',
  state: 'running',
  branch: 'dispatch/t-b',
  baseBranch: 'epic/e-1',
  worktreePath: '/tmp',
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
  costUsd: 0.42,
};

// a (landed) and b (an agent on it) → c → d; e is free to go; f is Maya's, started.
function plan(
  overrides: Partial<Record<string, Partial<TaskListItem['meta']>>> = {}
) {
  const base = [
    task('e-1', { kind: 'milestone', parent: null, status: 'working' }),
    task('t-a', { status: 'landed' }),
    task('t-b', { status: 'working' }),
    task('t-c', { blockedBy: ['t-a', 't-b'] }),
    task('t-d', { blockedBy: ['t-c'] }),
    task('t-e'),
    task('t-f', { status: 'working', assignee: 'human:maya' }),
  ];
  return base.map((t) => ({
    ...t,
    meta: { ...t.meta, ...overrides[t.meta.id] },
  }));
}

function progress(
  state: 'active' | 'paused',
  concurrency = 2,
  epicId = 'e-1'
): EpicProgress {
  return {
    epicId,
    active: state === 'active',
    session: {
      epicId,
      concurrency,
      executor: 'fake',
      state,
      maxSpendUsd: null,
      maxRuns: null,
      startedAt: '2026-09-20T00:00:00.000Z',
      startedBy: null,
      scope: 'plan',
      updatedAt: '2026-09-20T00:00:00.000Z',
      active: state === 'active',
    },
    spend: {
      settledUsd: 0,
      liveCount: 1,
      estimatedLiveUsd: 0,
      runsStarted: 1,
      maxSpendUsd: null,
      maxRuns: null,
    },
    children: [],
    waves: [],
    liveRuns: [],
  };
}

function dataWith(
  tasks: TaskListItem[],
  runs: RunMeta[] = [LIVE],
  sessions: EpicProgress[] = []
): DispatchProjectData {
  const noop = () => Promise.resolve();
  return {
    client: {},
    port: 1,
    config: null,
    tasks,
    tasksIncludingArchived: tasks,
    tasksReady: true,
    runs,
    latestRunByTaskId: new Map(runs.map((r) => [r.taskId, r])),
    liveRunStateByTaskId: new Map(
      runs.filter((r) => r.state === 'running').map((r) => [r.taskId, r.state])
    ),
    epicProgressById: new Map(sessions.map((p) => [p.epicId, p])),
    linearLinks: {},
    branches: [],
    readyIds: new Set(),
    handlePauseEpic: noop,
    handleResumeEpic: noop,
    handleStopEpic: noop,
    handleLandEpic: noop,
    handleWorkEpic: noop,
  } as unknown as DispatchProjectData;
}

function mount(
  data: DispatchProjectData,
  dispatchTask: (taskId: string) => Promise<void> = () => Promise.resolve(),
  containerId = 'e-1'
) {
  const opened: string[] = [];
  const view = (d: DispatchProjectData) => (
    <FlightPlan
      containerId={containerId}
      data={d}
      dispatchTask={dispatchTask}
      onDispatchFailed={() => {}}
      onOpenTask={(id) => opened.push(id)}
      openIn="page"
    />
  );
  const result = render(view(data));
  return {
    ...result,
    opened,
    rerenderWith: (d: DispatchProjectData) => result.rerender(view(d)),
  };
}

const node = (id: string) =>
  document.querySelector<HTMLElement>(
    `[data-slot=flight-node][data-node-id="${id}"]`
  );
const stateOf = (id: string) => node(id)?.getAttribute('data-state');
const sentenceOf = (id: string) =>
  node(id)?.querySelector('[data-slot=flight-node-sentence]')?.textContent;
const canvas = () => screen.getByRole('group', { name: /Flight plan for/ });

describe('FlightPlan', () => {
  test('draws each child in its wave with its live state and reason', () => {
    mount(dataWith(plan()));
    expect(
      Array.from(document.querySelectorAll('[data-slot=flight-wave-head]')).map(
        (h) => h.textContent
      )
    ).toEqual(['Wave 11/4Now', 'Wave 20/1', 'Wave 30/1']);
    expect(['t-a', 't-b', 't-c', 't-d', 't-e', 't-f'].map(stateOf)).toEqual([
      'done',
      'running',
      'blocked',
      'blocked',
      'queued',
      'teammate',
    ]);
    expect(sentenceOf('t-a')).toBe('Landed');
    expect(sentenceOf('t-b')).toBe('Working');
    // t-a has landed, so only t-b still holds t-c.
    expect(sentenceOf('t-c')).toBe('Unblocks when t-b finishes');
    expect(sentenceOf('t-e')).toBe('Ready to dispatch');
    expect(node('t-b')?.textContent).toContain('$0.42');
    // The chain still ahead — b → c → d — is the critical path.
    expect(
      ['t-b', 't-c', 't-d', 't-e'].map((id) =>
        node(id)?.hasAttribute('data-critical')
      )
    ).toEqual([true, true, true, false]);
  });

  test('under an active session, blocked nodes auto-start and queued ones take a place', () => {
    mount(dataWith(plan({ 't-g': {} }), [LIVE], [progress('active', 2)]));
    expect(sentenceOf('t-c')).toBe('Auto-starts when t-b finishes');
    // Two slots, one running: the queued node is next.
    expect(sentenceOf('t-e')).toBe('Next up');
    expect(
      document
        .querySelector('[data-slot=flight-slots]')
        ?.getAttribute('aria-label')
    ).toBe('1 of 2 slots in use');
  });

  test('a blocker landing flips its dependent in place and lights the edge', () => {
    const view = mount(dataWith(plan()));
    const before = node('t-c')?.style.transform;
    expect(
      document.querySelectorAll('[data-slot=flight-edge][data-tone=flowing]')
        .length
    ).toBe(1);
    view.rerenderWith(dataWith(plan({ 't-b': { status: 'landed' } }), []));
    expect(stateOf('t-c')).toBe('queued');
    expect(node('t-c')?.style.transform).toBe(before);
    expect(
      document.querySelectorAll('[data-slot=flight-edge][data-tone=landed]')
        .length
    ).toBe(2);
  });

  test('arrows walk the grid, Enter opens, d dispatches optimistically', async () => {
    const sent: string[] = [];
    const view = mount(dataWith(plan()), (id) => {
      sent.push(id);
      return new Promise(() => {});
    });
    const press = (key: string) => fireEvent.keyDown(canvas(), { key });
    press('ArrowDown');
    expect(canvas().getAttribute('aria-activedescendant')).toBe(
      'flight-node-t-a'
    );
    press('ArrowDown');
    press('ArrowDown');
    expect(canvas().getAttribute('aria-activedescendant')).toBe(
      'flight-node-t-e'
    );
    press('Enter');
    expect(view.opened).toEqual(['t-e']);
    await act(async () => {
      press('d');
      await Promise.resolve();
    });
    expect(sent).toEqual(['t-e']);
    expect(stateOf('t-e')).toBe('running');
    expect(sentenceOf('t-e')).toBe('Starting');
    // A blocked node is not dispatchable.
    press('ArrowRight');
    expect(canvas().getAttribute('aria-activedescendant')).toBe(
      'flight-node-t-c'
    );
    press('d');
    expect(sent).toEqual(['t-e']);
  });

  test('in a fan-out a teammate started, d sends my own task and never theirs', () => {
    const tasks = [
      task('e-1', { kind: 'milestone', parent: null, status: 'working' }),
      task('t-1', { assignee: 'human:maya' }),
      task('t-2', { assignee: 'human:wyat' }),
    ];
    const base = progress('active');
    const mayas: EpicProgress = {
      ...base,
      session:
        base.session === null
          ? null
          : { ...base.session, startedBy: 'human:maya' },
    };
    const sent: string[] = [];
    mount(
      {
        ...dataWith(tasks, [], [mayas]),
        localHuman: 'human:wyat',
      } as DispatchProjectData,
      (id) => {
        sent.push(id);
        return new Promise(() => {});
      }
    );
    const press = (key: string) => fireEvent.keyDown(canvas(), { key });
    const cursorAt = () => canvas().getAttribute('aria-activedescendant');
    press('ArrowDown');
    expect(cursorAt()).toBe('flight-node-t-1');
    press('d');
    expect(sent).toEqual([]);
    press('ArrowDown');
    expect(cursorAt()).toBe('flight-node-t-2');
    press('d');
    expect(sent).toEqual(['t-2']);
  });

  test('a project bands its milestones', () => {
    const tasks = [
      task('e-p', { kind: 'project', parent: null }),
      task('e-1', { kind: 'milestone', parent: 'e-p', title: 'Alpha' }),
      task('e-2', { kind: 'milestone', parent: 'e-p', title: 'Beta' }),
      task('t-1', { parent: 'e-1' }),
      task('t-2', { parent: 'e-2', blockedBy: ['t-1'] }),
    ];
    mount(dataWith(tasks, []), undefined, 'e-p');
    expect(
      Array.from(document.querySelectorAll('[data-slot=flight-band-head]')).map(
        (b) => b.getAttribute('data-band')
      )
    ).toEqual(['e-1', 'e-2']);
    expect(sentenceOf('t-2')).toBe('Unblocks when t-1 finishes');
  });

  test('a project’s header fans out every band, and the bands step aside while it runs', () => {
    const tasks = [
      task('e-p', { kind: 'project', parent: null }),
      task('e-1', { kind: 'milestone', parent: 'e-p', title: 'Alpha' }),
      task('e-2', { kind: 'milestone', parent: 'e-p', title: 'Beta' }),
      task('t-1', { parent: 'e-1' }),
      task('t-2', { parent: 'e-2' }),
      task('t-3', { parent: 'e-2' }),
    ];
    const header = () =>
      document.querySelector('[data-slot=flight-header]')?.textContent ?? '';
    const bandText = () =>
      Array.from(document.querySelectorAll('[data-slot=flight-band-head]'))
        .map((b) => b.textContent)
        .join('|');
    const view = mount(dataWith(tasks, []), undefined, 'e-p');
    expect(header()).toContain('Send agents');
    expect(bandText()).toContain('Send agents');

    // The project's session owns every milestone's nodes: one queue, its slots.
    view.rerenderWith(dataWith(tasks, [], [progress('active', 1, 'e-p')]));
    expect(bandText()).not.toContain('Send agents');
    expect(sentenceOf('t-1')).toBe('Next up');
    expect(sentenceOf('t-2')).toBe('#1 in queue');
    expect(sentenceOf('t-3')).toBe('#2 in queue');
  });

  test('a node the server will not start never reads as next up', () => {
    mount(
      dataWith(
        [
          task('e-1', { kind: 'milestone', parent: null }),
          task('e-9', { kind: 'milestone', parent: null }),
          task('t-9', { parent: 'e-9', status: 'working' }),
          task('t-1', { blockedBy: ['t-9'] }),
          task('t-2', { derivedFrom: 'github-pr:7' }),
          task('t-3'),
        ],
        [],
        [progress('active', 4)]
      )
    );
    expect(sentenceOf('t-1')).toBe('Auto-starts when t-9 finishes');
    expect(sentenceOf('t-2')).toBe('Anchors a review · agents never start it');
    expect(sentenceOf('t-3')).toBe('Next up');
  });

  test('a project session from before plan-wide fan-outs owns only its direct band', () => {
    const tasks = [
      task('e-p', { kind: 'project', parent: null }),
      task('e-1', { kind: 'milestone', parent: 'e-p', title: 'Alpha' }),
      task('t-1', { parent: 'e-1' }),
      task('t-2', { parent: 'e-p' }),
    ];
    const legacy = progress('active', 1, 'e-p');
    if (legacy.session !== null) legacy.session.scope = 'direct';
    mount(dataWith(tasks, [], [legacy]), undefined, 'e-p');
    // The server dispatches only t-2; Alpha may still fan out beside it.
    expect(sentenceOf('t-2')).toBe('Next up');
    expect(sentenceOf('t-1')).toBe('Ready to dispatch');
    const alpha = document.querySelector(
      '[data-slot=flight-band-head][data-band="e-1"]'
    );
    expect(alpha?.textContent).toContain('Send agents');
  });

  test('a teammate’s node is theirs: never queued, and d passes it by', async () => {
    const sent: string[] = [];
    mount(
      dataWith(
        [
          task('e-1', { kind: 'milestone', parent: null }),
          task('t-1', { assignee: 'human:sam' }),
          task('t-2', { blockedBy: ['t-1'] }),
        ],
        [],
        [progress('active', 2)]
      ),
      (id) => {
        sent.push(id);
        return Promise.resolve();
      }
    );
    expect(stateOf('t-1')).toBe('teammate');
    expect(sentenceOf('t-1')).toBe('sam’s — won’t auto-start');
    expect(sentenceOf('t-2')).toBe('Auto-starts when t-1 finishes');
    fireEvent.keyDown(canvas(), { key: 'ArrowDown' });
    expect(canvas().getAttribute('aria-activedescendant')).toBe(
      'flight-node-t-1'
    );
    await act(async () => {
      fireEvent.keyDown(canvas(), { key: 'd' });
      await Promise.resolve();
    });
    expect(sent).toEqual([]);
  });

  test('a band wears its milestone’s rolled-up status under a mirrored workflow on first load', () => {
    const linear = {
      ...testConfig,
      statuses: ['Todo', 'In Progress', 'Done', 'Canceled'],
      statusDefinitions: [
        { name: 'Todo', type: 'unstarted', color: null },
        { name: 'In Progress', type: 'started', color: null },
        { name: 'Done', type: 'completed', color: null },
        { name: 'Canceled', type: 'canceled', color: null },
      ],
      statusRoles: {
        ready: 'Todo',
        dispatched: 'In Progress',
        review: 'In Progress',
        landing: null,
        landed: 'Done',
        dropped: 'Canceled',
      },
    } as unknown as DispatchProjectData['config'];
    const tasks = [
      task('e-p', { kind: 'project', parent: null, status: 'In Progress' }),
      task('e-1', { kind: 'milestone', parent: 'e-p', status: 'In Progress' }),
      task('e-2', { kind: 'milestone', parent: 'e-p', status: 'Todo' }),
      task('t-1', { parent: 'e-1', status: 'Done' }),
      task('t-2', { parent: 'e-2', status: 'Todo', blockedBy: ['t-1'] }),
    ];
    // As in useDispatchProject: config lands after the tasks, and the open project's model
    // is set in an effect after the render that carries it.
    function App({ config }: { config: DispatchProjectData['config'] }) {
      useEffect(() => {
        setActiveStatusModel(config === null ? null : statusModelOf(config));
      }, [config]);
      return (
        <FlightPlan
          containerId="e-p"
          data={{ ...dataWith(tasks, []), config }}
          dispatchTask={() => Promise.resolve()}
          onDispatchFailed={() => {}}
          onOpenTask={() => {}}
          openIn="page"
        />
      );
    }
    const { rerender } = render(<App config={null} />);
    act(() => rerender(<App config={linear} />));
    const bandStatus = (key: string) =>
      document
        .querySelector(
          `[data-slot=flight-band-head][data-band="${key}"] [role=img]`
        )
        ?.getAttribute('aria-label');
    expect(bandStatus('e-1')).toBe('Status: Done');
    expect(bandStatus('e-2')).toBe('Status: Todo');
  });

  test('an empty container says what will appear', () => {
    mount(dataWith([task('e-1', { kind: 'milestone', parent: null })], []));
    expect(screen.getByText('Nothing to plan yet')).toBeTruthy();
  });

  test('the section draws from the app’s host, and nothing without one', () => {
    const { container, unmount } = render(
      <ContainerFlightPlanSection containerId="e-1" />
    );
    expect(container.innerHTML).toBe('');
    unmount();
    render(
      <FlightPlanHostContext.Provider
        value={{
          data: dataWith(plan()),
          dispatchTask: () => Promise.resolve(),
          onDispatchFailed: () => {},
          onOpenTask: () => {},
          onPeekTask: () => {},
        }}
      >
        <ContainerFlightPlanSection containerId="e-1" />
      </FlightPlanHostContext.Provider>
    );
    expect(document.querySelectorAll('[data-slot=flight-node]')).toHaveLength(
      6
    );
  });
});
