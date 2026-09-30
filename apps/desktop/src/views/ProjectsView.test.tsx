import type { TaskDoc } from '@dispatch/core/browser';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test } from 'bun:test';

import {
  type CreateTaskPreset,
  type ShellActions,
  ShellActionsProvider,
} from '../components/shell/ShellActionsContext';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import {
  ProjectsView,
  TOGGLED_PROJECT_NODES_STORAGE_KEY,
} from './ProjectsView';

beforeEach(() => window.sessionStorage.clear());

function task(
  id: string,
  title: string,
  overrides: Partial<TaskDoc['meta']> = {}
): TaskDoc {
  return {
    meta: {
      id,
      title,
      status: 'ready',
      kind: 'task',
      priority: 'none',
      parent: null,
      milestone: null,
      labels: [],
      assignee: 'none',
      blockedBy: [],
      writes: [],
      initiatives: [],
      dueDate: null,
      color: null,
      created: '2026-08-10T12:00:00.000Z',
      updated: '2026-09-13T12:00:00.000Z',
      ...overrides,
    },
    body: '',
  } as unknown as TaskDoc;
}

function dataWith(
  tasks: TaskDoc[],
  attention: string[] = []
): DispatchProjectData {
  return {
    client: {},
    portLoading: false,
    portError: false,
    tasks,
    attentionByTaskId: new Map(attention.map((id) => [id, 'failed'])),
  } as unknown as DispatchProjectData;
}

function renderProjects(data: DispatchProjectData) {
  const opened: string[] = [];
  const creates: (CreateTaskPreset | undefined)[] = [];
  const actions = {
    openCreateTask: (preset?: CreateTaskPreset) => creates.push(preset),
  } as unknown as ShellActions;
  const result = render(
    <ShellActionsProvider value={actions}>
      <ProjectsView
        projectName="Acme"
        data={data}
        onOpenTask={(id) => opened.push(id)}
      />
    </ShellActionsProvider>
  );
  return { ...result, opened, creates };
}

const growth = task('i-1', 'Growth', { kind: 'initiative' });
const storefront = task('p-1', 'Storefront', {
  kind: 'project',
  parent: 'i-1',
  assignee: 'human:maya',
  dueDate: '2099-01-10',
});
const beta = task('m-1', 'Beta', { kind: 'milestone', parent: 'p-1' });
const hierarchy = [
  growth,
  storefront,
  beta,
  task('t-1', 'Checkout', { parent: 'm-1', status: 'working' }),
  task('t-2', 'Card form', { parent: 't-1', status: 'landed' }),
  task('t-3', 'Receipt', { parent: 'm-1' }),
];

function rowKeys(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-row-key]')
  ).map((row) => row.dataset.rowKey ?? '');
}

test('initiatives and projects open onto their milestones, each with its progress', () => {
  const { container } = renderProjects(dataWith(hierarchy));
  expect(rowKeys(container)).toEqual(['i-1', 'i-1/p-1', 'i-1/p-1/m-1']);
  const project = container.querySelector('[data-row-key="i-1/p-1"]');
  expect(
    project
      ?.querySelector('[data-slot=container-progress]')
      ?.getAttribute('aria-label')
  ).toBe('1 of 3 done');
  expect(project?.textContent).toContain('1/3');
  expect(project?.textContent).toContain('33%');
  expect(project?.textContent).toContain('On track');
  expect(
    project?.querySelector('[data-slot=container-target]')?.textContent
  ).toContain('Jan 10');
  // The lead's avatar.
  expect(project?.querySelector('[data-kind=human]')).not.toBeNull();
});

test('a failed run below a container marks it at risk', () => {
  const { container } = renderProjects(dataWith(hierarchy, ['t-3']));
  expect(
    container.querySelector(
      '[data-row-key="i-1/p-1/m-1"] [data-slot=container-health]'
    )?.textContent
  ).toBe('At risk');
});

test('j/k move, l opens and steps in, h closes and steps out, Enter opens the page', () => {
  const { container, opened } = renderProjects(dataWith(hierarchy));
  const grid = screen.getByRole('treegrid', { name: 'Projects' });
  expect(document.activeElement).toBe(grid);
  const cursor = () => grid.getAttribute('aria-activedescendant');

  expect(cursor()).toBe('project-row-i-1');
  fireEvent.keyDown(grid, { key: 'j' });
  fireEvent.keyDown(grid, { key: 'j' });
  expect(cursor()).toBe('project-row-i-1--p-1--m-1');

  // l on a folded milestone opens it; again steps onto its first issue.
  fireEvent.keyDown(grid, { key: 'l' });
  expect(rowKeys(container)).toContain('i-1/p-1/m-1/t-1');
  expect(window.sessionStorage.getItem(TOGGLED_PROJECT_NODES_STORAGE_KEY)).toBe(
    '["i-1/p-1/m-1"]'
  );
  fireEvent.keyDown(grid, { key: 'l' });
  expect(cursor()).toBe('project-row-i-1--p-1--m-1--t-1');

  // h on a folded issue steps out to its milestone; h there folds it.
  fireEvent.keyDown(grid, { key: 'h' });
  expect(cursor()).toBe('project-row-i-1--p-1--m-1');
  fireEvent.keyDown(grid, { key: 'h' });
  expect(rowKeys(container)).not.toContain('i-1/p-1/m-1/t-1');

  // Enter on a container opens its page — the Flight Plan.
  fireEvent.keyDown(grid, { key: 'k' });
  fireEvent.keyDown(grid, { key: 'Enter' });
  expect(opened).toEqual(['p-1']);
});

test('the chevron folds a node without opening it; a click on the row opens it', () => {
  const { container, opened } = renderProjects(dataWith(hierarchy));
  const project = container.querySelector<HTMLElement>(
    '[data-row-key="i-1/p-1"]'
  );
  const chevron = project?.querySelector<HTMLElement>(
    'button[aria-label=Collapse]'
  );
  if (project === null || chevron === undefined || chevron === null) {
    throw new Error('no project row');
  }
  fireEvent.click(chevron);
  expect(rowKeys(container)).toEqual(['i-1', 'i-1/p-1']);
  expect(opened).toEqual([]);
  fireEvent.click(project);
  expect(opened).toEqual(['p-1']);
});

test('with no containers the empty state says what the page is for', () => {
  renderProjects(dataWith([task('t-1', 'Loose')]));
  expect(screen.getByText('No projects yet')).not.toBeNull();
});

test("the empty state's New project opens the creator on a project", () => {
  const { creates } = renderProjects(dataWith([]));
  fireEvent.click(screen.getByRole('button', { name: /New project/ }));
  expect(creates).toEqual([{ kind: 'project' }]);
});

test('2000 tasks mount only a window of rows', () => {
  const tasks: TaskDoc[] = [task('p-0', 'Big', { kind: 'project' })];
  for (let m = 0; m < 20; m++) {
    tasks.push(task(`m-${m}`, `M${m}`, { kind: 'milestone', parent: 'p-0' }));
    for (let i = 0; i < 99; i++) {
      tasks.push(task(`t-${m}-${i}`, `Issue ${m}.${i}`, { parent: `m-${m}` }));
    }
  }
  // Every milestone open: 2000 rows in the tree.
  window.sessionStorage.setItem(
    TOGGLED_PROJECT_NODES_STORAGE_KEY,
    JSON.stringify(Array.from({ length: 20 }, (_, m) => `p-0/m-${m}`))
  );
  const { container } = renderProjects(dataWith(tasks));
  const mounted = container.querySelectorAll('[data-row-key]').length;
  expect(mounted).toBeGreaterThan(10);
  expect(mounted).toBeLessThan(100);
});
