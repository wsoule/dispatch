import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { MilestoneProgress, RunMeta } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
import { ToastProvider } from '../components/shell/Toasts';
import { SHELL } from '../components/tasks/page/pageHost.test-helper';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { type PlanningInput, PlanningProvider } from '../hooks/usePlanning';
import { perfBudgetMs } from '../lib/perfBudget.test-helper';
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

function planningInput(tasks: TaskListItem[]): PlanningInput {
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
  daemon?: 'ready' | 'starting';
}

function mount(options: MountOptions = {}) {
  const tasks = options.tasks ?? fixture();
  const creates: (CreateTaskPreset | undefined)[] = [];
  const starting = options.daemon === 'starting';
  const data = {
    client: starting ? null : {},
    portLoading: starting,
    portError: false,
    portErrorDetail: null,
    retryEnsureDispatchd: () => {},
  } as unknown as DispatchProjectData;
  const utils = render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <ShellActionsProvider
          value={{ ...SHELL, openCreateTask: (preset) => creates.push(preset) }}
        >
          <PlanningProvider data={planningInput(tasks)}>
            <ProjectsView data={data} />
          </PlanningProvider>
        </ShellActionsProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
  return { ...utils, creates };
}

/** The rows on screen, by their accessible row link name. */
function rowNames(): string[] {
  return screen
    .getAllByRole('link', { name: /^Open / })
    .map((link) => link.getAttribute('aria-label') ?? '');
}

function row(name: string): HTMLElement {
  const link = screen.getByRole('link', { name: `Open ${name}` });
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
      'Open Storefront',
      'Open Search',
      'Open Loose ends',
      'Open Archive',
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

  test('a row carries the status chip, next milestone, progress and lead', () => {
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
    // No Allocation column: the Lead cell already says what blocks it.
    expect(within(store).queryByText('Nothing to do')).toBeNull();

    // Search: no lead, its next milestone overdue, allocation blocked.
    const search = row('Search');
    expect(search.getAttribute('data-tone')).toBe('warning');
    expect(within(search).getByRole('img', { name: 'Overdue' })).toBeTruthy();
    expect(within(search).getByText(/days overdue$/)).toBeTruthy();
    // "No lead" is quiet: the row's own tone and the filter carry the warning.
    const noLead = within(search).getByText('No lead');
    expect(noLead.closest('[data-tone]')?.getAttribute('data-tone')).toBe(
      'muted'
    );
    expect(within(search).queryByText('Project has no lead')).toBeNull();

    // Loose ends: no milestone, so the next-milestone cell says so, and
    // there is no progress to draw.
    const loose = row('Loose ends');
    expect(within(loose).getAllByText('No open milestone')).toHaveLength(1);
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
  });

  test('the row and its cells are real hrefs: the timeline lane, the issues, the graph, the page', () => {
    mount();
    const store = row('Storefront');
    expect(
      within(store)
        .getByRole('link', { name: 'Storefront on the timeline' })
        .getAttribute('href')
    ).toBe('#/timeline?project=p-store');
    expect(
      within(store)
        .getByRole('link', { name: 'Issues of Storefront' })
        .getAttribute('href')
    ).toBe('#/issues?project=p-store');
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

  test('the column floors fit the register width it stacks under', () => {
    mount();
    const register = row('Storefront').closest<HTMLElement>('[data-stack]');
    if (register === null) throw new Error('no register');
    // The register stacks its rows under its own width (stackWithin), so
    // above that width every row must fit: the floors of the tracks, a 20px
    // gap between each and 14px of padding each side (register.module.css's
    // --register-gap and --register-pad-x). Over it, the end cell's Open
    // button is clipped by the panel.
    const stack = /^container-(\d+)$/.exec(
      register.getAttribute('data-stack') ?? ''
    );
    const within = Number(stack?.[1]);
    expect(within).toBe(900);
    const columns = register.style.getPropertyValue('--register-cols');
    const tracks = columns.match(/minmax\([^)]*\)|\S+/g) ?? [];
    expect(tracks.length).toBe(6);
    const floors = tracks.map((track) =>
      Number(/^(?:minmax\()?(\d+)px/.exec(track)?.[1])
    );
    expect(floors.every((px) => Number.isFinite(px))).toBe(true);
    const total =
      floors.reduce((sum, px) => sum + px, 0) + 20 * (tracks.length - 1) + 28;
    expect(total).toBeLessThanOrEqual(within);
    // The end cell's floor holds its three 26px buttons and their 2px gaps.
    expect(floors.at(-1)).toBeGreaterThanOrEqual(3 * 26 + 2 * 2);
  });

  test('the filter and the search narrow the rows and the count says so', () => {
    mount();
    const filters = screen.getByRole('radiogroup', { name: 'Project status' });
    expect(
      within(filters)
        .getAllByRole('radio')
        .map((option) => option.textContent)
    ).toEqual(['All4', 'Blocked1', 'At risk1', 'Inactive1']);
    // Unnarrowed, the header carries the count; the toolbar adds none.
    expect(screen.queryByText('4 projects')).toBeNull();

    fireEvent.click(within(filters).getByRole('radio', { name: /Blocked/ }));
    expect(rowNames()).toEqual(['Open Search']);
    expect(screen.getByText('1 of 4 projects')).toBeTruthy();
    // Groups left empty are gone with their rows.
    expect(screen.queryByRole('region', { name: 'No initiative' })).toBeNull();

    fireEvent.click(within(filters).getByRole('radio', { name: /Inactive/ }));
    expect(rowNames()).toEqual(['Open Archive']);

    fireEvent.click(within(filters).getByRole('radio', { name: /All/ }));
    const search = screen.getByRole('searchbox', { name: 'Search projects' });
    fireEvent.change(search, { target: { value: 'dev' } });
    expect(rowNames()).toEqual(['Open Loose ends', 'Open Archive']);
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

  test('the header offers New project and no back chip (Projects is a sidebar page)', () => {
    const { creates } = mount();
    expect(screen.queryByTestId('tasks-back')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(creates).toEqual([{ kind: 'project' }]);
  });

  test('without a daemon it shows the daemon state instead of the register', () => {
    mount({ daemon: 'starting' });
    expect(screen.queryByTestId('projects-view')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  test('300 projects render in under a second', () => {
    // A small mount first, so the clock measures drawing 300 rows rather than
    // the first render's module and JIT warm-up (most of a cold mount, and
    // the part a busy CI runner stretches: 1,064 and 1,375 ms there against
    // about 260 ms warm here).
    mount({ tasks: many(3) });
    cleanup();
    const started = performance.now();
    mount({ tasks: many(300) });
    const elapsed = performance.now() - started;
    expect(rowNames()).toHaveLength(300);
    // eslint-disable-next-line no-console
    console.log(`300 projects: planning + register in ${elapsed.toFixed(0)}ms`);
    expect(elapsed).toBeLessThan(perfBudgetMs(1000));
  });
});
