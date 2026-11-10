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
// cover what the page adds: the levels (initiatives, projects, milestones,
// issues) and drilling between them, a route's scope narrowing the tasks,
// the trail back up, the drawer, and the draw cap. Where the view is lives in
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

/** The fixture with Storefront under a Growth initiative; Search is in none. */
function withInitiative(): TaskListItem[] {
  return [
    taskDoc({
      id: 'i-growth',
      title: 'Growth',
      kind: 'initiative',
      status: 'working',
    }),
    ...fixture().map((task) =>
      task.meta.id === 'p-store'
        ? { ...task, meta: { ...task.meta, parent: 'i-growth' } }
        : task
    ),
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

/** The cards on the chart (a level above issues), by their title attribute. */
async function cardTitles(): Promise<string[]> {
  return milestoneTitles();
}

/** A task's card on the Issues level, once laid out. */
function taskCard(id: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = screen
      .queryAllByTestId('chart-task')
      .find((el) => el.closest(`[data-chart-node="${id}"]`) !== null);
    if (found === undefined) throw new Error(`no ${id} card`);
    return found;
  });
}

/** The level tabs' names, the current one starred. */
function levels(): string[] {
  const nav = screen.queryByRole('navigation', { name: 'Graph level' });
  if (nav === null) return [];
  return within(nav)
    .getAllByRole('link')
    .map(
      (link) =>
        `${link.textContent ?? ''}${link.getAttribute('aria-current') === 'page' ? '*' : ''}`
    );
}

/** A card by its title, double-clicked: the way down a level. */
async function drill(title: string): Promise<void> {
  const card = (
    await screen.findAllByTestId('milestone-node', {}, { timeout: 10_000 })
  ).find((node) => node.getAttribute('title') === title);
  if (card === undefined) throw new Error(`no ${title} card`);
  fireEvent.doubleClick(card);
}

describe('GraphView', () => {
  test('opens on the milestone level, a card per milestone, with the levels as tabs', async () => {
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
    // No initiatives in this workspace: no Initiatives tab, and no trail at the top.
    expect(levels()).toEqual(['Projects', 'Milestones*', 'Issues']);
    expect(
      screen.queryByRole('navigation', { name: 'Graph scope' })
    ).toBeNull();
  });

  test('the Projects level draws a card per project with the waits between them', async () => {
    mount({ scope: { level: 'project' } });
    expect((await cardTitles()).sort()).toEqual(['Search', 'Storefront']);
    expect(screen.getByTestId('milestone-map-summary').textContent).toContain(
      '2 projects · 1 wait between them'
    );
    expect(levels()).toEqual(['Projects*', 'Milestones', 'Issues']);
  });

  test('a double-click drills project → milestones → tasks, and the trail climbs back', async () => {
    const { log } = mount({ scope: { level: 'project' } });
    await drill('Storefront');
    expect(log.at(-1)).toEqual({
      type: 'openGraph',
      scope: { level: 'milestone', projectId: 'p-store' },
      nodeId: null,
    });
    // Storefront's milestones, and Index that its cart work waits on.
    await waitFor(async () =>
      expect((await cardTitles()).sort()).toEqual([
        'Search › Index',
        'Storefront › Beta',
        'Storefront › Launch',
      ])
    );
    expect(levels()).toEqual(['Milestones*', 'Issues']);
    await drill('Storefront › Launch');
    expect(log.at(-1)).toEqual({
      type: 'openGraph',
      scope: { level: 'issue', milestoneId: 'ms-launch' },
      nodeId: null,
    });
    await taskCard('t-announce');
    // Launch's announcement waits on Beta's cart work, so the cart comes along.
    await taskCard('t-cart');
    const trail = screen.getByRole('navigation', { name: 'Graph scope' });
    expect(
      within(trail)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')])
    ).toEqual([
      ['Workspace', '#/graph?level=project'],
      ['Storefront', '#/graph?project=p-store&level=milestone'],
    ]);
    expect(trail.textContent).toContain('Launch');
  });

  test('with initiatives, the Initiatives level draws them and drills into their projects', async () => {
    const { log } = mount({
      tasks: withInitiative(),
      scope: { level: 'initiative' },
    });
    expect((await cardTitles()).sort()).toEqual(['Growth', 'No initiative']);
    expect(levels()).toEqual([
      'Initiatives*',
      'Projects',
      'Milestones',
      'Issues',
    ]);
    await drill('Growth');
    expect(log.at(-1)).toEqual({
      type: 'openGraph',
      scope: { level: 'project', initiativeId: 'i-growth' },
      nodeId: null,
    });
    // Storefront, and Search that its cart work waits on.
    await waitFor(async () =>
      expect((await cardTitles()).sort()).toEqual(['Search', 'Storefront'])
    );
  });

  test('Open task quick-looks the task in the shell’s drawer', async () => {
    const peekTask = mock((_id: string) => {});
    mount({ peekTask, scope: { level: 'issue' } });
    fireEvent.click(await taskCard('t-cart'));
    fireEvent.click(
      within(screen.getByTestId('chart-inspector')).getByRole('button', {
        name: 'Open task',
      })
    );
    expect(peekTask).toHaveBeenCalledWith('t-cart');
  });

  test('past the draw cap the milestones to narrow to stand where the canvas would', async () => {
    mount({ tasks: oversized(TASK_DRAW_CAP + 5), scope: { level: 'issue' } });
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
