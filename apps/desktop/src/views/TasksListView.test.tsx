import type { TaskDoc } from '@dispatch/core/browser';
import { statusModelOf } from '@dispatch/core/browser';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { type ReactNode, useEffect } from 'react';

import { PeopleProvider } from '../components/people/PeopleContext';
import {
  linearWorkflowConfig,
  testConfig,
} from '../components/settings/fixtures.test-helper';
import {
  type DeepLinkActions,
  DeepLinkProvider,
} from '../components/shell/DeepLinkContext';
import {
  type CreateTaskPreset,
  type ShellActions,
  ShellActionsProvider,
} from '../components/shell/ShellActionsContext';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { setActiveStatusModel } from '../lib/statusModel';
import { DEFAULT_TASKS_DISPLAY } from '../lib/tasksPrefs';
import { TasksListView } from './TasksListView';

// Collapse state is session-scoped; start every test with nothing folded.
beforeEach(() => window.sessionStorage.clear());
// Unmount before resetting, so the reset does not redraw a mounted list outside act.
afterEach(() => {
  cleanup();
  setActiveStatusModel(null);
});

/** Every dispatch the bulk bar made, in order. */
interface DispatchCall {
  taskId: string;
  batch: boolean | undefined;
  optimistic?: boolean;
}

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
      priority: 'medium',
      parent: null,
      milestone: null,
      labels: [],
      assignee: 'none',
      blockedBy: [],
      writes: [],
      created: '2026-08-10T12:00:00.000Z',
      updated: '2026-09-13T12:00:00.000Z',
      ...overrides,
    },
    body: '',
  } as unknown as TaskDoc;
}

/** A `DispatchProjectData` stub carrying everything `TasksListView` reads. */
function dataWith(
  tasks: TaskDoc[],
  calls: DispatchCall[] = [],
  epics: TaskDoc[] = []
): DispatchProjectData {
  return {
    config: testConfig,
    tasks,
    tasksIncludingArchived: tasks,
    archivedTasks: [],
    showArchived: false,
    epics,
    epicProgressById: new Map(),
    readyIds: new Set(tasks.map((t) => t.meta.id)),
    latestRunByTaskId: new Map(),
    liveRunStateByTaskId: new Map(),
    attentionByTaskId: new Map(),
    moveTaskStatus: async () => {},
    handleUpdate: async () => {},
    handleDispatch: (
      taskId: string,
      _executor?: string,
      _model?: string,
      opts?: { batch?: boolean; optimistic?: boolean }
    ) => {
      calls.push({
        taskId,
        batch: opts?.batch,
        ...(opts?.optimistic !== undefined && { optimistic: opts.optimistic }),
      });
      return Promise.resolve();
    },
  } as unknown as DispatchProjectData;
}

interface ShellLog {
  presets: CreateTaskPreset[];
  peeked: string[];
  copied: string[];
}

function shellLog(): ShellLog {
  return { presets: [], peeked: [], copied: [] };
}

/** The shell seam the list needs: `+` presets, peek, copy id. Records what it was asked. */
function shellWith(log: ShellLog) {
  const noop = () => {};
  const actions = {
    openTask: noop,
    openThread: noop,
    peekTask: (id: string) => log.peeked.push(id),
    openCreateTask: (preset?: CreateTaskPreset) =>
      log.presets.push(preset ?? {}),
    createPreset: null,
    closeCreateTask: noop,
    openPalette: noop,
    toggleSidebar: noop,
    sidebarHidden: false,
    openOverseer: noop,
    setProjectView: noop,
    setGlobalView: noop,
    openShortcuts: noop,
    copyTaskId: (id: string) => log.copied.push(id),
  } satisfies ShellActions;
  return function Shell({ children }: { children: ReactNode }) {
    return (
      <ShellActionsProvider value={actions}>{children}</ShellActionsProvider>
    );
  };
}

function renderList(
  data: DispatchProjectData,
  onSelectTask: (id: string) => void = () => {},
  log = shellLog(),
  deepLink: DeepLinkActions | null = null
) {
  const Shell = shellWith(log);
  const view = <TasksListView data={data} onSelectTask={onSelectTask} />;
  const result = render(
    <Shell>
      {deepLink === null ? (
        view
      ) : (
        <DeepLinkProvider value={deepLink}>{view}</DeepLinkProvider>
      )}
    </Shell>
  );
  return { ...result, log };
}

function rowOf(title: string): HTMLElement {
  const row = screen
    .getByText(title)
    .closest<HTMLElement>('[data-slot="list-row"]');
  if (row === null) throw new Error(`no row for ${title}`);
  return row;
}

function rowById(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-row-id="${id}"]`);
  if (row === null) throw new Error(`no row ${id}`);
  return row;
}

/** Ticks each named row's select box, opens the bulk dialog from the selection bar, and
 *  confirms it. The bar and the dialog both label their button "Dispatch N", so the confirm
 *  is reached through the dialog rather than by name alone. */
function bulkDispatch(titles: string[]) {
  for (const title of titles) {
    fireEvent.click(screen.getByLabelText(`Select ${title}`));
  }
  fireEvent.click(
    screen.getByRole('button', { name: `Dispatch ${titles.length}` })
  );
  const dialog = within(screen.getByRole('dialog'));
  fireEvent.click(dialog.getByRole('button', { name: /^Send \d+ agents?$/ }));
}

// The failure this covers: the bulk bar loops handleDispatch, so a naive implementation fires
// the hook's onRunDispatched once per task — the app yanks the user through each new run's
// Chat tab in turn and strands them on the last one, several history entries deep.
test('a bulk dispatch of several tasks does not follow any of them', async () => {
  const calls: DispatchCall[] = [];
  renderList(
    dataWith([task('t-1', 'First task'), task('t-2', 'Second task')], calls)
  );

  bulkDispatch(['First task', 'Second task']);

  await waitFor(() => expect(calls.length).toBe(2));
  expect(calls.map((c) => c.taskId)).toEqual(['t-1', 't-2']);
  expect(calls.every((c) => c.batch === true)).toBe(true);
});

test('a bulk dispatch of one task still follows it', async () => {
  const calls: DispatchCall[] = [];
  renderList(
    dataWith([task('t-1', 'First task'), task('t-2', 'Second task')], calls)
  );

  bulkDispatch(['First task']);

  await waitFor(() => expect(calls.length).toBe(1));
  expect(calls[0]?.batch).toBe(false);
});

// `d` goes through the optimistic path, like the Cockpit's: the row shows as started at
// once and the list stays where it is.
test('d dispatches the focused ready row in place', async () => {
  const calls: DispatchCall[] = [];
  const data = dataWith(
    [task('t-1', 'First task'), task('t-2', 'Second task')],
    calls
  );
  renderList({ ...data, readyIds: new Set(['t-2']) });
  const grid = screen.getByRole('grid', { name: 'Tasks' });

  fireEvent.keyDown(grid, { key: 'd' });
  fireEvent.keyDown(grid, { key: 'j' });
  fireEvent.keyDown(grid, { key: 'd' });

  await waitFor(() => expect(calls.length).toBe(1));
  expect(calls).toEqual([
    { taskId: 't-2', batch: undefined, optimistic: true },
  ]);
});

// Dispatching regroups the row under its new status; the cursor stays where it was, on the
// row that took its place, so `d` `d` walks down the Ready group.
test('after d moves the row to another group, the cursor stays in place', () => {
  const calls: DispatchCall[] = [];
  const tasks = [
    task('t-1', 'First task', { status: 'todo' }),
    task('t-2', 'Second task', { status: 'todo' }),
    task('t-3', 'Third task', { status: 'todo' }),
  ];
  const view = (list: typeof tasks) => (
    <TasksListView
      data={{ ...dataWith(list, calls), readyIds: new Set(['t-1', 't-2']) }}
      onSelectTask={() => {}}
    />
  );
  const Shell = shellWith(shellLog());
  const { rerender } = render(<Shell>{view(tasks)}</Shell>);
  const grid = screen.getByRole('grid', { name: 'Tasks' });
  expect(rowOf('First task').getAttribute('data-focused')).toBe('true');

  fireEvent.keyDown(grid, { key: 'd' });
  // The optimistic status lands: t-1 now sorts into In progress, below the Todo rows.
  rerender(
    <Shell>
      {view([
        task('t-1', 'First task', { status: 'in-progress' }),
        tasks[1],
        tasks[2],
      ])}
    </Shell>
  );
  expect(rowOf('Second task').getAttribute('data-focused')).toBe('true');
});

// §4: rows are 36px ListRows straight on the panel — no table, no header row, no divider,
// no filter input; the id is sans, the date absolute, labels are pills.
test('renders each task as a 36px ListRow with pickers, label pills, a sans id and an absolute date', () => {
  const { container } = renderList(
    dataWith([task('t-1', 'First task', { labels: ['ui'] })])
  );

  expect(container.querySelector('table')).toBeNull();
  expect(container.querySelector('input[type="text"]')).toBeNull();
  expect(screen.queryByPlaceholderText(/filter/i)).toBeNull();

  const row = rowOf('First task');
  expect(row.className.split(/\s+/)).toContain('h-9');
  expect(row.className).not.toContain('font-mono');
  expect(row.querySelector('[data-slot="list-row-id"]')?.textContent).toBe(
    't-1'
  );
  expect(
    row.querySelector('[data-slot="list-row-id"]')?.className
  ).not.toContain('font-mono');
  expect(row.querySelector('[data-slot="list-row-date"]')?.textContent).toMatch(
    /^Sep 13(, 2026)?$/
  );
  expect(row.querySelector('[data-slot="label-pill"]')?.textContent).toBe('ui');
  expect(screen.getByRole('button', { name: 'Change status' })).not.toBeNull();
  expect(
    screen.getByRole('button', { name: 'Change priority' })
  ).not.toBeNull();
  // Selection lives in a hover-only checkbox, never a tinted row.
  expect(screen.getByLabelText('Select First task')).not.toBeNull();
  expect(row.className).not.toContain('accent');
});

test('groups by status in config order by default, with a tinted header and a + per group', () => {
  const { container, log } = renderList(
    dataWith([
      task('t-1', 'Working task', { status: 'working' }),
      task('t-2', 'Todo task', { status: 'todo' }),
      task('t-3', 'Ready task', { status: 'ready' }),
    ])
  );

  // `testConfig` lists backlog/todo/in-progress/…; `working` and `ready` are the built-in
  // statuses a task file carries, so they trail the configured ones in first-seen order.
  const headers = Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="group-header"]')
  );
  expect(
    headers.map(
      (h) => h.querySelector('[data-slot="group-header-name"]')?.textContent
    )
  ).toEqual(['Todo', 'Working', 'Ready']);
  expect(headers[0]?.className.split(/\s+/)).toContain('h-9');
  expect(headers[0]?.className.split(/\s+/)).toContain('status-tint');
  expect(headers[2]?.style.getPropertyValue('--tint')).toBe(
    'var(--status-todo)'
  );
  expect(
    headers[0]?.querySelector('[data-slot="group-header-count"]')?.textContent
  ).toBe('1');

  fireEvent.click(screen.getByRole('button', { name: 'New task in Ready' }));
  expect(log.presets).toEqual([{ status: 'ready' }]);
});

test('a task under an epic in the same group nests 24px under it with a dimmer tree row', () => {
  const epic = task('e-1', 'Payments epic', { kind: 'milestone' });
  const { container } = renderList(
    dataWith([epic, task('t-1', 'Charge card', { parent: 'e-1' })], [], [epic])
  );

  const rows = Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="list-row"]')
  );
  expect(rows.map((r) => r.dataset.rowId)).toEqual(['e-1', 't-1']);
  expect(rows[1]?.getAttribute('data-indent')).toBe('1');
  expect(
    rows[1]?.querySelector('[data-slot="list-row-connector"]')
  ).not.toBeNull();
  // The epic row carries the `▶ N` sub-task count pill; the child wears the epic chip.
  expect(rowById('e-1').querySelector('[title="1 sub-tasks"]')).not.toBeNull();
  expect(
    rowById('t-1').querySelector('[title="Payments epic"]')
  ).not.toBeNull();
});

test('clicking a row opens that task', () => {
  const opened: string[] = [];
  renderList(
    dataWith([task('t-1', 'First task'), task('t-2', 'Second task')]),
    (id) => opened.push(id)
  );

  fireEvent.click(screen.getByText('Second task'));

  expect(opened).toEqual(['t-2']);
});

test('hovering a row moves the keyboard cursor to it', () => {
  renderList(dataWith([task('t-1', 'First task'), task('t-2', 'Second task')]));

  expect(rowOf('First task').getAttribute('data-focused')).toBe('true');
  fireEvent.mouseEnter(rowOf('Second task'));
  expect(rowOf('Second task').getAttribute('data-focused')).toBe('true');
  expect(rowOf('First task').getAttribute('data-focused')).toBeNull();
});

test('the single-key set: j/k move, x selects, Enter opens, Space peeks, s opens the status picker', () => {
  const opened: string[] = [];
  const { log } = renderList(
    dataWith([task('t-1', 'First task'), task('t-2', 'Second task')]),
    (id) => opened.push(id)
  );
  const grid = screen.getByRole('grid', { name: 'Tasks' });
  // The list takes focus on mount so the keys work without a click first.
  expect(document.activeElement).toBe(grid);

  fireEvent.keyDown(grid, { key: 'j' });
  expect(rowOf('Second task').getAttribute('data-focused')).toBe('true');
  // The grid names the cursor row for assistive tech; every row has a DOM id for it.
  expect(rowOf('Second task').id).toBe('task-row-t-2');
  expect(grid.getAttribute('aria-activedescendant')).toBe(
    rowOf('Second task').id
  );
  fireEvent.keyDown(grid, { key: 'ArrowUp' });
  expect(rowOf('First task').getAttribute('data-focused')).toBe('true');
  expect(grid.getAttribute('aria-activedescendant')).toBe(
    rowOf('First task').id
  );

  fireEvent.keyDown(grid, { key: 'x' });
  expect(rowOf('First task').getAttribute('data-selected')).toBe('true');
  expect(screen.getByText('1 selected')).not.toBeNull();
  fireEvent.keyDown(grid, { key: 'Escape' });
  expect(screen.queryByText('1 selected')).toBeNull();

  fireEvent.keyDown(grid, { key: 'Enter' });
  fireEvent.keyDown(grid, { key: 'o' });
  expect(opened).toEqual(['t-1', 't-1']);

  fireEvent.keyDown(grid, { key: ' ' });
  expect(log.peeked).toEqual(['t-1']);

  fireEvent.keyDown(grid, { key: 's' });
  expect(
    rowById('t-1')
      .querySelector('[aria-label="Change status"]')
      ?.getAttribute('aria-expanded')
  ).toBe('true');
  expect(
    rowById('t-2')
      .querySelector('[aria-label="Change status"]')
      ?.getAttribute('aria-expanded')
  ).toBe('false');

  fireEvent.keyDown(grid, { key: 'c', metaKey: true });
  expect(log.copied).toEqual(['t-1']);
});

// The flagship edit flow: `s`, arrows, Enter. The picker menu is portaled, so React still
// bubbles its keydowns up to the grid — those belong to the menu, never to the row cursor.
test('keys inside an open picker menu do not reach the list (s then Enter picks, never opens)', async () => {
  const opened: string[] = [];
  const moved: [string, string][] = [];
  const data = dataWith([task('t-1', 'First task')]);
  data.moveTaskStatus = (id: string, status: string) => {
    moved.push([id, status]);
    return Promise.resolve();
  };
  renderList(data, (id) => opened.push(id));
  const grid = screen.getByRole('grid', { name: 'Tasks' });

  fireEvent.keyDown(grid, { key: 's' });
  const menu = await screen.findByRole('menu');
  const item = within(menu).getByRole('menuitem', { name: /todo/i });
  expect(grid.contains(item)).toBe(false);

  fireEvent.keyDown(item, { key: 'Enter' });
  fireEvent.keyDown(item, { key: 'j' });
  fireEvent.keyDown(item, { key: ' ' });
  expect(opened).toEqual([]);
  expect(rowOf('First task').getAttribute('data-focused')).toBe('true');
  fireEvent.click(item);
  expect(moved).toEqual([['t-1', 'todo']]);
  expect(opened).toEqual([]);
});

test('collapsing the only group keeps its header so it can be expanded again', () => {
  const { container } = renderList(dataWith([task('t-1', 'Only task')]));

  fireEvent.click(screen.getByRole('button', { name: 'Collapse group' }));

  expect(screen.queryByText('Only task')).toBeNull();
  expect(screen.queryByText('No tasks match')).toBeNull();
  expect(container.querySelectorAll('[data-slot="group-header"]').length).toBe(
    1
  );
  fireEvent.click(screen.getByRole('button', { name: 'Expand group' }));
  expect(screen.getByText('Only task')).not.toBeNull();
});

/** The row menu's labels in order, shortcuts stripped. */
async function menuLabels(): Promise<(string | undefined)[]> {
  const menu = await screen.findByRole('menu');
  return within(menu)
    .getAllByRole('menuitem')
    .map((item) => item.textContent?.replace(/[A-Z⌘]+$|Space$/u, '').trim());
}

test('the context menu offers the property submenus, open/peek/dispatch/copy, archive and drop', async () => {
  const linked: string[] = [];
  renderList(dataWith([task('t-1', 'First task')]), () => {}, shellLog(), {
    copyTaskLink: (id) => linked.push(id),
  });

  fireEvent.contextMenu(rowOf('First task'), { clientX: 10, clientY: 10 });

  const menu = await screen.findByRole('menu');
  expect(await menuLabels()).toEqual([
    'Status',
    'Priority',
    'Assignee',
    'Labels',
    'Epic',
    'Milestone',
    'Open',
    'Peek',
    'Dispatch',
    'Copy id',
    'Copy link',
    'Archive',
    'Drop',
  ]);
  expect(within(menu).getByText('S')).not.toBeNull();
  expect(within(menu).getByText('⌘C')).not.toBeNull();

  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy link' }));
  expect(linked).toEqual(['t-1']);
});

test('the Assignee submenu never offers the unknown-Linear-user placeholder', async () => {
  const people = [
    { ref: 'human:wyat', name: 'Wyat Soule' },
    {
      ref: 'human:linear-user',
      name: 'Unknown Linear user',
      placeholder: true,
    },
  ];
  const Shell = shellWith(shellLog());
  render(
    <Shell>
      <PeopleProvider people={people} me="human:wyat">
        <TasksListView
          data={dataWith([task('t-1', 'First task')])}
          onSelectTask={() => {}}
        />
      </PeopleProvider>
    </Shell>
  );

  fireEvent.contextMenu(rowOf('First task'), { clientX: 10, clientY: 10 });
  const menu = await screen.findByRole('menu');
  await act(async () => {
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Assignee/ }));
    await Promise.resolve();
  });

  const [, submenu] = await screen.findAllByRole('menu');
  if (submenu === undefined) throw new Error('no Assignee submenu');
  // Each label follows its avatar's initials.
  expect(
    within(submenu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent)
  ).toEqual([
    expect.stringMatching(/Wyat Soule$/),
    expect.stringMatching(/Agent$/),
    expect.stringMatching(/Unassigned$/),
  ]);
});

// Outside App's `DeepLinkProvider` (the harness, most view tests) there is nothing to
// copy a link with, so the row menu shows no `Copy link`.
test('the context menu has no Copy link without a deep-link provider', async () => {
  renderList(dataWith([task('t-1', 'First task')]));

  fireEvent.contextMenu(rowOf('First task'), { clientX: 10, clientY: 10 });

  const labels = await menuLabels();
  expect(labels).toContain('Copy id');
  expect(labels).not.toContain('Copy link');
});

test('collapsing a group hides its rows and takes them out of the keyboard order', () => {
  const opened: string[] = [];
  renderList(
    dataWith([
      task('t-1', 'Ready task', { status: 'ready' }),
      task('t-2', 'Working task', { status: 'working' }),
    ]),
    (id) => opened.push(id)
  );

  const [collapseTodo] = screen.getAllByRole('button', {
    name: 'Collapse group',
  });
  if (collapseTodo === undefined) throw new Error('no group chevron');
  fireEvent.click(collapseTodo);
  expect(screen.queryByText('Ready task')).toBeNull();
  expect(screen.getByText('Working task')).not.toBeNull();

  fireEvent.keyDown(screen.getByRole('grid', { name: 'Tasks' }), {
    key: 'Enter',
  });
  expect(opened).toEqual(['t-2']);
});

test('display prefs drive grouping and which properties a row shows', () => {
  const epic = task('e-1', 'Payments epic', { kind: 'milestone' });
  const Shell = shellWith(shellLog());
  const { container } = render(
    <Shell>
      <TasksListView
        data={dataWith(
          [epic, task('t-1', 'Charge card', { parent: 'e-1' })],
          [],
          [epic]
        )}
        onSelectTask={() => {}}
        display={{
          ...DEFAULT_TASKS_DISPLAY,
          grouping: 'epic',
          properties: new Set(['status']),
        }}
      />
    </Shell>
  );

  expect(
    container.querySelector('[data-slot="group-header-name"]')?.textContent
  ).toBe('Payments epic');
  const row = rowOf('Charge card');
  expect(row.querySelector('[data-slot="list-row-id"]')).toBeNull();
  expect(row.querySelector('[data-slot="list-row-date"]')).toBeNull();
  expect(row.querySelector('[data-slot="list-row-leading"]')).toBeNull();
  expect(screen.getByRole('button', { name: 'Change status' })).not.toBeNull();
  expect(screen.queryByRole('button', { name: 'Change priority' })).toBeNull();
});

test('grouped by milestone, a mirrored workflow sinks and tints finished work on its first load', () => {
  const shipped = task('e-2', 'Shipped', { kind: 'milestone' });
  const payments = task('e-1', 'Payments', { kind: 'milestone' });
  const tasks = [
    shipped,
    task('t-9', 'Old work', { parent: 'e-2', status: 'Done' }),
    task('t-8', 'Dropped work', { parent: 'e-2', status: 'Canceled' }),
    payments,
    task('t-3', 'Receipts', { parent: 'e-1', status: 'Done' }),
    task('t-1', 'Charge card', { parent: 'e-1', status: 'QA' }),
    task('t-2', 'Refund flow', { parent: 'e-1', status: 'Todo' }),
  ];
  const Shell = shellWith(shellLog());
  // As in useDispatchProject: config lands after the tasks, and the open project's model
  // is set in an effect after the render that carries it.
  function App({ config }: { config: DispatchProjectData['config'] }) {
    useEffect(() => {
      setActiveStatusModel(config === null ? null : statusModelOf(config));
    }, [config]);
    const data = {
      ...dataWith(tasks, [], [shipped, payments]),
      config,
    } as DispatchProjectData;
    return (
      <Shell>
        <TasksListView
          data={data}
          onSelectTask={() => {}}
          display={{ ...DEFAULT_TASKS_DISPLAY, grouping: 'milestone' }}
        />
      </Shell>
    );
  }
  const { container, rerender } = render(<App config={null} />);
  act(() => rerender(<App config={linearWorkflowConfig} />));

  const headers = Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="group-header"]')
  );
  expect(
    headers.map(
      (h) => h.querySelector('[data-slot="group-header-name"]')?.textContent
    )
  ).toEqual(['Payments', 'Shipped']);
  expect(headers[0]?.querySelector('[aria-label="Status: QA"]')).not.toBeNull();
  expect(headers[0]?.style.getPropertyValue('--tint')).toBe(
    'var(--status-progress)'
  );
  expect(headers[1]?.style.getPropertyValue('--tint')).toBe(
    'var(--status-done)'
  );
  // Done sinks below the open rows in its group.
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="list-row"]')
  ).map((r) => r.dataset.rowId);
  expect(rows.slice(0, 3)).toEqual(['t-1', 't-2', 't-3']);
});

test('an empty filter result shows the no-match empty state', () => {
  const Shell = shellWith(shellLog());
  render(
    <Shell>
      <TasksListView
        data={dataWith([task('t-1', 'First task')])}
        onSelectTask={() => {}}
        taskFilter={() => false}
      />
    </Shell>
  );

  expect(screen.getByText('No tasks match')).not.toBeNull();
});

// 2000 tasks under status headers: the grid mounts a screenful, and j/k walk it by
// scrolling the focused row in rather than rendering everything.
const MANY = Array.from({ length: 2000 }, (_, i) =>
  task(`t-${String(i).padStart(4, '0')}`, `Task ${i}`)
);

function mountedRowIds(): string[] {
  return Array.from(document.querySelectorAll('[data-row-id]')).map(
    (row) => row.getAttribute('data-row-id') ?? ''
  );
}

test('2000 tasks mount a screenful of rows, headers included', () => {
  renderList(dataWith(MANY));
  const ids = mountedRowIds();
  expect(ids.length).toBeGreaterThan(10);
  expect(ids.length).toBeLessThan(60);
  expect(
    document.querySelectorAll('[data-slot="group-header"]').length
  ).toBeGreaterThan(0);
});

test('j moves the cursor onto a mounted row', () => {
  renderList(dataWith(MANY));
  const grid = screen.getByRole('grid', { name: 'Tasks' });
  fireEvent.keyDown(grid, { key: 'j' });
  expect(grid.getAttribute('aria-activedescendant')).toBe('task-row-t-0001');
  // The cursor's row is always mounted — `aria-activedescendant` points at a real node.
  expect(document.getElementById('task-row-t-0001')).not.toBeNull();
});

test('the focused row stays mounted after the list scrolls away from it', () => {
  renderList(dataWith(MANY));
  const grid = screen.getByRole('grid', { name: 'Tasks' });
  fireEvent.keyDown(grid, { key: 'j' });
  act(() => {
    grid.scrollTop = 36 * 1500;
    fireEvent.scroll(grid);
  });
  const ids = mountedRowIds();
  expect(ids).toContain('t-1499');
  expect(ids).toContain('t-0001');
  expect(ids).not.toContain('t-0100');
});

test('collapsing a group drops its rows but keeps its header row', () => {
  renderList(
    dataWith([
      task('t-1', 'Ready one'),
      task('t-2', 'Done one', { status: 'done' }),
    ])
  );
  const readyHeader = document.querySelector('[data-group-key="status:ready"]');
  const toggle = readyHeader?.querySelector<HTMLElement>(
    'button[aria-label="Collapse group"]'
  );
  if (toggle === null || toggle === undefined) throw new Error('no toggle');
  fireEvent.click(toggle);
  expect(screen.queryByText('Ready one') === null).toBe(true);
  expect(screen.queryByText('Done one') === null).toBe(false);
  expect(document.querySelectorAll('[data-slot="group-header"]').length).toBe(
    2
  );
});
