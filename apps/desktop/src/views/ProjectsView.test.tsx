import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { EpicProgress, RunMeta } from '@dispatch/client';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  type CreateTaskPreset,
  ShellActionsProvider,
} from '../components/shell/ShellActionsContext';
import { SHELL } from '../components/tasks/page/pageHost.test-helper';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { type PlanningInput, PlanningProvider } from '../hooks/usePlanning';
import { dayFromNow } from '../lib/taskDates';
import { taskDoc } from '../lib/taskDoc.test-helper';
import { ProjectsView } from './ProjectsView';

// The Projects register over a fixture planning (PlanningProvider runs the
// chain over the task list below): an initiative with two projects, one
// without an initiative and one inactive, so every filter has a row. Dates
// are relative to today so the overdue milestone stays overdue.

afterEach(cleanup);

const DONE_MEANS = '## Description\n\nDone means: it ships.\n';

/**
 * Growth: Storefront (lead Ana, Beta due in 20 days, on track) and Search
 * (no lead, Index due 3 days ago with an unassigned issue: overdue and
 * blocked). Outside any initiative: Loose ends (no milestone) and Archive
 * (a draft project: inactive).
 */
function fixture(): TaskListItem[] {
  return [
    taskDoc({ id: 'i-growth', title: 'Growth', kind: 'initiative' }),
    taskDoc({
      id: 'p-store',
      title: 'Storefront',
      kind: 'project',
      parent: 'i-growth',
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
    taskDoc({
      id: 't-cart',
      title: 'Persist the cart',
      parent: 'ms-beta',
      status: 'working',
      assignee: 'human:ana',
    }),
    taskDoc({
      id: 't-pay',
      title: 'Take payments',
      parent: 'ms-beta',
      status: 'landed',
      assignee: 'human:ana',
    }),
    taskDoc({
      id: 'p-search',
      title: 'Search',
      kind: 'project',
      parent: 'i-growth',
      status: 'working',
      assignee: 'none',
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
    taskDoc({
      id: 'p-loose',
      title: 'Loose ends',
      kind: 'project',
      status: 'ready',
      assignee: 'human:dev',
    }),
    taskDoc({
      id: 'p-archive',
      title: 'Archive',
      kind: 'project',
      status: 'draft',
      assignee: 'human:dev',
    }),
  ];
}

/** `count` projects, each with one milestone and one issue, in one initiative. */
function many(count: number): TaskListItem[] {
  const tasks = [taskDoc({ id: 'i-big', title: 'Big', kind: 'initiative' })];
  for (let i = 0; i < count; i += 1) {
    tasks.push(
      taskDoc({
        id: `p-${i}`,
        title: `Project ${i}`,
        kind: 'project',
        parent: 'i-big',
        status: 'working',
        assignee: 'human:ana',
      }),
      taskDoc(
        {
          id: `ms-${i}`,
          title: `Milestone ${i}`,
          kind: 'milestone',
          parent: `p-${i}`,
          dueDate: dayFromNow(30),
        },
        DONE_MEANS
      ),
      taskDoc({
        id: `t-${i}`,
        title: `Issue ${i}`,
        parent: `ms-${i}`,
        status: 'ready',
        assignee: 'human:ana',
      })
    );
  }
  return tasks;
}

function run(id: string): RunMeta {
  return { id, taskId: 't-cart', state: 'running' } as RunMeta;
}

/** Fan-out progress for one container with these runs live under it. */
function progress(epicId: string, runIds: string[]): EpicProgress {
  return {
    epicId,
    active: true,
    session: null,
    spend: { usd: 0, runs: 0 },
    children: [],
    waves: [],
    liveRuns: runIds.map(run),
  } as unknown as EpicProgress;
}

function planningInput(
  tasks: TaskListItem[],
  epicProgressById: Map<string, EpicProgress>
): PlanningInput {
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
    epicProgressById,
  };
}

interface MountOptions {
  tasks?: TaskListItem[];
  epicProgressById?: Map<string, EpicProgress>;
  onBack?: () => void;
  daemon?: 'ready' | 'starting';
}

function mount(options: MountOptions = {}) {
  const tasks = options.tasks ?? fixture();
  const epicProgressById =
    options.epicProgressById ?? new Map<string, EpicProgress>();
  const creates: (CreateTaskPreset | undefined)[] = [];
  const starting = options.daemon === 'starting';
  const data = {
    client: starting ? null : {},
    portLoading: starting,
    portError: false,
    portErrorDetail: null,
    retryEnsureDispatchd: () => {},
    epicProgressById,
  } as unknown as DispatchProjectData;
  const utils = render(
    <ShellActionsProvider
      value={{ ...SHELL, openCreateTask: (preset) => creates.push(preset) }}
    >
      <PlanningProvider data={planningInput(tasks, epicProgressById)}>
        <ProjectsView data={data} onBack={options.onBack} />
      </PlanningProvider>
    </ShellActionsProvider>
  );
  return { ...utils, creates };
}

/** The rows on screen, by their accessible row link name. */
function rowNames(): string[] {
  return screen
    .getAllByRole('link', { name: / on the timeline$/ })
    .map((link) => link.getAttribute('aria-label') ?? '');
}

function row(name: string): HTMLElement {
  const link = screen.getByRole('link', { name: `${name} on the timeline` });
  const item = link.closest('li');
  if (item === null) throw new Error(`no row for ${name}`);
  return item;
}

describe('ProjectsView', () => {
  test('groups the projects by initiative, "No initiative" last, with the receipts line', () => {
    mount();
    expect(screen.getByTestId('projects-view')).toBeTruthy();
    const groups = screen
      .getAllByRole('region')
      .map((section) => section.getAttribute('aria-label'));
    expect(groups).toEqual(['Growth', 'No initiative']);
    expect(rowNames()).toEqual([
      'Storefront on the timeline',
      'Search on the timeline',
      'Loose ends on the timeline',
      'Archive on the timeline',
    ]);
    expect(
      screen.getByText('4 projects in 1 initiative · 1 at risk')
    ).toBeTruthy();
    // Each group's Graph button opens the initiative's graph.
    expect(
      screen
        .getByRole('link', { name: 'Dependency graph of Growth' })
        .getAttribute('href')
    ).toBe('#/graph?initiative=i-growth');
    expect(
      screen
        .getByRole('link', { name: 'Dependency graph of No initiative' })
        .getAttribute('href')
    ).toBe('#/graph?initiative=none');
  });

  test('a row carries the status chip, next milestone, progress, lead and allocation', () => {
    mount();
    const store = row('Storefront');
    expect(store.getAttribute('data-tone')).toBe('default');
    // The project's own status name, in the info tone (started).
    const status = within(store).getByText('Working');
    expect(status.closest('[data-tone]')?.getAttribute('data-tone')).toBe(
      'info'
    );
    expect(within(store).getByText('Growth')).toBeTruthy();
    expect(within(store).getByText('Beta')).toBeTruthy();
    expect(within(store).getByRole('img', { name: 'On track' })).toBeTruthy();
    expect(
      within(store)
        .getByRole('progressbar', { name: 'Beta progress' })
        .getAttribute('aria-valuetext')
    ).toBe('1 of 2 done');
    expect(within(store).getByText('Ana')).toBeTruthy();
    expect(within(store).getByText('Nothing to do')).toBeTruthy();

    // Search: no lead, its next milestone overdue, allocation blocked.
    const search = row('Search');
    expect(search.getAttribute('data-tone')).toBe('warning');
    expect(within(search).getByRole('img', { name: 'Overdue' })).toBeTruthy();
    expect(within(search).getByText(/days overdue$/)).toBeTruthy();
    const noLead = within(search).getByText('No lead');
    expect(noLead.closest('[data-tone]')?.getAttribute('data-tone')).toBe(
      'warning'
    );
    expect(within(search).getByText('Blocked')).toBeTruthy();
    expect(within(search).getByText('Project has no lead')).toBeTruthy();

    // Loose ends: no milestone, so the next-milestone and the allocation
    // cells both say so, and there is no progress to draw.
    const loose = row('Loose ends');
    expect(within(loose).getAllByText('No open milestone')).toHaveLength(2);
    expect(within(loose).getByText('—')).toBeTruthy();

    // Archive: a draft project is inactive; its row and chip step back.
    const archive = row('Archive');
    expect(archive.getAttribute('data-tone')).toBe('muted');
    expect(
      within(archive)
        .getByText('Draft')
        .closest('[data-tone]')
        ?.getAttribute('data-tone')
    ).toBe('muted');
    expect(within(archive).getByText('Inactive')).toBeTruthy();
  });

  test('the row and its cells are real hrefs: the timeline lane, the graph, the page', () => {
    mount();
    const store = row('Storefront');
    expect(
      within(store)
        .getByRole('link', { name: 'Storefront on the timeline' })
        .getAttribute('href')
    ).toBe('#/timeline?project=p-store');
    expect(
      within(store)
        .getByRole('link', { name: 'Graph of Storefront' })
        .getAttribute('href')
    ).toBe('#/graph?project=p-store');
    expect(
      within(store)
        .getByRole('link', { name: 'Open Storefront' })
        .getAttribute('href')
    ).toBe('#/task/p-store');
  });

  test('agents working under a project or its milestones fill the allocation cell', () => {
    mount({
      epicProgressById: new Map([
        ['p-store', progress('p-store', ['r-1'])],
        ['ms-beta', progress('ms-beta', ['r-1', 'r-2'])],
      ]),
    });
    const cell = within(row('Storefront')).getByText('2 agents working');
    expect(cell.closest('[data-tone]')?.getAttribute('data-tone')).toBe('info');
  });

  test('the filter and the search narrow the rows and the count says so', () => {
    mount();
    const filters = screen.getByRole('radiogroup', { name: 'Project status' });
    expect(
      within(filters)
        .getAllByRole('radio')
        .map((option) => option.textContent)
    ).toEqual(['All4', 'Blocked1', 'At risk1', 'Inactive1']);
    expect(screen.getByText('4 projects')).toBeTruthy();

    fireEvent.click(within(filters).getByRole('radio', { name: /Blocked/ }));
    expect(rowNames()).toEqual(['Search on the timeline']);
    expect(screen.getByText('1 of 4 projects')).toBeTruthy();
    // Groups left empty are gone with their rows.
    expect(screen.queryByRole('region', { name: 'No initiative' })).toBeNull();

    fireEvent.click(within(filters).getByRole('radio', { name: /Inactive/ }));
    expect(rowNames()).toEqual(['Archive on the timeline']);

    fireEvent.click(within(filters).getByRole('radio', { name: /All/ }));
    const search = screen.getByRole('searchbox', { name: 'Search projects' });
    fireEvent.change(search, { target: { value: 'dev' } });
    expect(rowNames()).toEqual([
      'Loose ends on the timeline',
      'Archive on the timeline',
    ]);
    expect(screen.getByText('2 of 4 projects')).toBeTruthy();
  });

  test('no match offers Show all, which clears the search and the filter', () => {
    mount();
    const search = screen.getByRole('searchbox', { name: 'Search projects' });
    fireEvent.change(search, { target: { value: 'nothing here' } });
    expect(
      screen.queryAllByRole('link', { name: / on the timeline$/ })
    ).toEqual([]);
    expect(screen.getByText('No projects match "nothing here"')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all projects' }));
    expect(rowNames()).toHaveLength(4);
    expect(document.activeElement).toBe(search);
  });

  test('with no projects the empty state offers New project, which opens the creator on a project', () => {
    const { creates } = mount({
      tasks: [taskDoc({ id: 't-1', title: 'Loose task' })],
    });
    expect(screen.getByText('No projects yet')).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(creates).toEqual([{ kind: 'project' }]);
  });

  test('hosted under Tasks, the header leads with "‹ tasks" and offers New project', () => {
    const backs: string[] = [];
    const { creates } = mount({ onBack: () => backs.push('back') });
    fireEvent.click(screen.getByTestId('tasks-back'));
    expect(backs).toEqual(['back']);
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(creates).toEqual([{ kind: 'project' }]);
    cleanup();
    // On its own (no host) the header has no back chip.
    mount();
    expect(screen.queryByTestId('tasks-back')).toBeNull();
  });

  test('without a daemon it shows the daemon state instead of the register', () => {
    mount({ daemon: 'starting' });
    expect(screen.queryByTestId('projects-view')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  test('300 projects render in under a second', () => {
    const started = performance.now();
    mount({ tasks: many(300) });
    const elapsed = performance.now() - started;
    expect(rowNames()).toHaveLength(300);
    // eslint-disable-next-line no-console
    console.log(`300 projects: planning + register in ${elapsed.toFixed(0)}ms`);
    expect(elapsed).toBeLessThan(1000);
  });
});
