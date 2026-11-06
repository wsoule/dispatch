import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { MilestoneProgress, RunMeta } from '@dispatch/client';
import type { GraphScope } from '@dispatch/planning';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { useReducer } from 'react';

import { TASK_DRAW_CAP } from '../components/graph/MilestoneMap';
import { testConfig } from '../components/settings/fixtures.test-helper';
import { ShellActionsProvider } from '../components/shell/ShellActionsContext';
import { SHELL } from '../components/tasks/page/pageHost.test-helper';
import { type PlanningInput, PlanningProvider } from '../hooks/usePlanning';
import {
  DEFAULT_GRAPH_SCOPE,
  initialNavState,
  type NavAction,
  navReducer,
} from '../lib/appNav';
import { dayFromNow } from '../lib/taskDates';
import { taskDoc } from '../lib/taskDoc.test-helper';
import type { TaskBucket } from '../lib/taskStatus';
import { GraphView, type GraphViewProps } from './GraphView';

// The Graph page over a fixture planning (PlanningProvider runs the chain
// over the task list below): two projects, three milestones and issues whose
// blocking relations cross the milestones, so the milestone chart has lines.
// The chart itself (components/graph/MilestoneMap) has its own tests; these
// cover what the page adds: the tasks grouped by milestone, a route's scope
// narrowing them, the drawer, and the draw cap. Where the view is lives in
// App's nav reducer, so the harness (GraphHost) runs one and hands the page's
// scope back to the view.

afterEach(cleanup);

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // No storage: the view opens on its defaults anyway.
  }
});

const DONE_MEANS = '## Description\n\nDone means: it ships.\n';

/**
 * Storefront (lead Ana): Beta due in 20 days, Launch in 40. Search (lead
 * Dev): Index due 3 days ago (overdue) with an unassigned open issue that
 * blocks Beta's cart work, which in turn blocks Launch's announcement: a
 * risk chain Index → Beta → Launch across the two projects.
 */
function fixture(): TaskListItem[] {
  return [
    taskDoc({
      id: 'p-store',
      title: 'Storefront',
      kind: 'project',
      status: 'working',
      assignee: 'human:ana',
    }),
    taskDoc(
      {
        id: 'ms-beta',
        title: 'Beta',
        kind: 'milestone',
        parent: 'p-store',
        dueDate: dayFromNow(20),
      },
      DONE_MEANS
    ),
    taskDoc(
      {
        id: 'ms-launch',
        title: 'Launch',
        kind: 'milestone',
        parent: 'p-store',
        dueDate: dayFromNow(40),
      },
      DONE_MEANS
    ),
    taskDoc({
      id: 't-cart',
      title: 'Persist the cart',
      parent: 'ms-beta',
      status: 'working',
      assignee: 'human:ana',
      blockedBy: ['t-rank'],
    }),
    taskDoc({
      id: 't-announce',
      title: 'Announce the launch',
      parent: 'ms-launch',
      status: 'ready',
      assignee: 'human:ana',
      blockedBy: ['t-cart'],
    }),
    taskDoc({
      id: 'p-search',
      title: 'Search',
      kind: 'project',
      status: 'working',
      assignee: 'human:dev',
    }),
    taskDoc(
      {
        id: 'ms-index',
        title: 'Index',
        kind: 'milestone',
        parent: 'p-search',
        dueDate: dayFromNow(-3),
      },
      DONE_MEANS
    ),
    taskDoc({
      id: 't-rank',
      title: 'Rank exact matches first',
      parent: 'ms-index',
      status: 'ready',
      assignee: 'none',
    }),
  ];
}

/** One project, one milestone and `count` issues in one chain. */
function oversized(count: number): TaskListItem[] {
  const tasks = [
    taskDoc({
      id: 'p-big',
      title: 'Big',
      kind: 'project',
      status: 'working',
      assignee: 'human:ana',
    }),
    taskDoc(
      {
        id: 'ms-big',
        title: 'Everything',
        kind: 'milestone',
        parent: 'p-big',
        dueDate: dayFromNow(30),
      },
      DONE_MEANS
    ),
  ];
  for (let i = 0; i < count; i += 1) {
    tasks.push(
      taskDoc({
        id: `t-${i}`,
        title: `Issue ${i}`,
        parent: 'ms-big',
        status: 'ready',
        assignee: 'human:ana',
        blockedBy: i > 0 ? [`t-${i - 1}`] : [],
      })
    );
  }
  return tasks;
}

function input(tasks: TaskListItem[]): PlanningInput {
  return {
    tasks,
    config: null,
    people: [
      { ref: 'human:ana', name: 'Ana' },
      { ref: 'human:dev', name: 'Dev' },
    ],
    executors: null,
    me: 'human:ana',
    linearLinks: {},
    latestRunByTaskId: new Map<string, RunMeta>(),
    milestoneProgressById: new Map<string, MilestoneProgress>(),
  };
}

interface MountOptions {
  tasks?: TaskListItem[];
  peekTask?: (taskId: string) => void;
  /** The scope the page opens on; the workspace by default. */
  scope?: GraphScope;
  /** Every nav action the view dispatches, in order. */
  log?: NavAction[];
  /** No project config yet (the window still loading). */
  noConfig?: boolean;
}

type HostProps = Omit<GraphViewProps, 'scope' | 'nodeId' | 'onNavigate'> & {
  scope: GraphScope;
  log: NavAction[];
};

/** App's side of the view: the nav reducer, opened on the Graph page at
 * `scope`, whose page the view draws and whose dispatch its links reach. */
function GraphHost({ scope, log, ...rest }: HostProps) {
  const [state, dispatch] = useReducer(navReducer, scope, (opening) =>
    navReducer(initialNavState, {
      type: 'openGraph',
      scope: opening,
      nodeId: null,
    })
  );
  const page = state.tasksPage;
  if (page.kind !== 'view' || page.view !== 'graph') {
    return <p>left the graph</p>;
  }
  return (
    <GraphView
      {...rest}
      scope={page.scope}
      nodeId={page.nodeId}
      onNavigate={(action) => {
        log.push(action);
        dispatch(action);
      }}
    />
  );
}

function mount(options: MountOptions = {}) {
  const tasks = options.tasks ?? fixture();
  const planning = input(tasks);
  const log = options.log ?? [];
  const utils = render(
    <ShellActionsProvider
      value={{ ...SHELL, peekTask: options.peekTask ?? (() => {}) }}
    >
      <PlanningProvider data={planning}>
        <GraphHost
          data={{
            tasks,
            milestones: tasks.filter(
              (task) =>
                task.meta.kind !== undefined && task.meta.kind !== 'task'
            ),
            config: options.noConfig === true ? null : testConfig,
          }}
          bucketOf={(): TaskBucket | null => null}
          asksByTask={new Map()}
          projectKey="graph-test"
          scope={options.scope ?? DEFAULT_GRAPH_SCOPE}
          log={log}
        />
      </PlanningProvider>
    </ShellActionsProvider>
  );
  return { ...utils, log };
}

// The chart lays out asynchronously (elkjs): its nodes appear after the first render, and
// the first layout in a process also loads the ELK bundle.
async function milestoneTitles(): Promise<string[]> {
  const nodes = await screen.findAllByTestId(
    'milestone-node',
    {},
    { timeout: 10_000 }
  );
  return nodes.map((node) => node.getAttribute('title') ?? '');
}

describe('GraphView', () => {
  test('opens on the milestone chart, a card per milestone', async () => {
    mount();
    const view = screen.getByTestId('graph-view');
    expect(
      within(view).getByRole('heading', { level: 1, name: 'Dependencies' })
    ).toBeTruthy();
    expect((await milestoneTitles()).sort()).toEqual([
      'Search › Index',
      'Storefront › Beta',
      'Storefront › Launch',
    ]);
    expect(
      screen.queryByRole('button', { name: 'Whole workspace' })
    ).toBeNull();
  });

  test('a scoped route draws only its tasks and those they wait on; Whole workspace leaves it', async () => {
    const { log } = mount({
      scope: { level: 'issue', milestoneId: 'ms-launch' },
    });
    // Launch's announcement waits on Beta's cart work: Beta comes along, Index does not.
    await waitFor(async () =>
      expect((await milestoneTitles()).sort()).toEqual([
        'Storefront › Beta',
        'Storefront › Launch',
      ])
    );
    expect(screen.getByText(/Showing Launch/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Whole workspace' }));
    expect(log.at(-1)).toEqual({
      type: 'openGraph',
      scope: DEFAULT_GRAPH_SCOPE,
      nodeId: null,
    });
    await waitFor(async () => expect(await milestoneTitles()).toHaveLength(3));
  });

  test('Open task quick-looks the task in the shell’s drawer', async () => {
    const peekTask = mock((_id: string) => {});
    mount({ peekTask });
    await milestoneTitles();
    fireEvent.click(screen.getByRole('radio', { name: 'Tasks' }));
    const card = await waitFor(() => {
      const found = screen
        .queryAllByTestId('chart-task')
        .find((el) => el.closest('[data-chart-node="t-cart"]') !== null);
      if (found === undefined) throw new Error('no t-cart card');
      return found;
    });
    fireEvent.click(card);
    fireEvent.click(
      within(screen.getByTestId('chart-inspector')).getByRole('button', {
        name: 'Open task',
      })
    );
    expect(peekTask).toHaveBeenCalledWith('t-cart');
  });

  test('past the draw cap the milestones to narrow to stand where the canvas would', async () => {
    window.localStorage.setItem('dispatch:graph-mode:graph-test', 'tasks');
    mount({ tasks: oversized(TASK_DRAW_CAP + 5) });
    const section = await screen.findByRole('region', {
      name: 'Too many to draw',
    });
    expect(section.textContent).toContain(`${TASK_DRAW_CAP + 5} tasks`);
    const row = within(section).getByRole('link', { name: /Everything/ });
    expect(row.getAttribute('href')).toContain('milestone=ms-big');
    expect(screen.queryByTestId('chart-stage')).toBeNull();
  });

  test('says so while the project has no config yet', () => {
    mount({ noConfig: true });
    expect(screen.getByText('The graph is not available here.')).toBeTruthy();
  });
});
