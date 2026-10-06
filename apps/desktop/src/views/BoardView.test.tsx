import type { TaskDoc } from '@dispatch-foo/core/browser';
import type {
  EpicProgress,
  EpicSession,
  ReadinessReading,
} from '@dispatch/client';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'bun:test';
import { type ReactNode, useState } from 'react';

import {
  linearWorkflowConfig,
  testConfig,
} from '../components/settings/fixtures.test-helper';
import {
  SavedViewsProvider,
  useSavedViewsContext,
} from '../components/shell/SavedViewsContext';
import {
  type ShellActions,
  ShellActionsProvider,
} from '../components/shell/ShellActionsContext';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { type SavedViewsApi, useSavedViews } from '../hooks/useSavedViews';
import type { WorkEpicOptions } from '../lib/epicSession';
import { TASK_FILTERS_V2_STORAGE_KEY } from '../lib/taskFilters';
import {
  TASK_FILTERS_STORAGE_KEY,
  TASKS_DISPLAY_STORAGE_KEY,
} from '../lib/tasksPrefs';
import {
  type TasksViewMode,
  VIEW_MODE_STORAGE_KEY,
} from '../lib/tasksViewMode';
import { BoardView } from './BoardView';
import type { FocusEpicRequest } from './MilestonesView';
import { TooltipProvider } from '@/ui/tooltip';

function task(
  id: string,
  title: string,
  status: string,
  parent: string | null = null,
  kind = 'task',
  priority = 'medium'
): TaskDoc {
  return {
    meta: {
      id,
      title,
      status,
      kind,
      priority,
      parent,
      milestone: null,
      labels: [],
      assignee: 'none',
      blockedBy: [],
      writes: [],
      created: '2026-08-10T00:00:00.000Z',
      updated: '2026-08-10T00:00:00.000Z',
    },
    body: '',
  } as unknown as TaskDoc;
}

const EPICS = [
  task('e-1', 'Payments epic', 'todo', null, 'epic'),
  task('e-2', 'Search epic', 'todo', null, 'epic'),
];

const TASKS = [
  ...EPICS,
  task('t-1', 'Card one', 'todo', 'e-1'),
  task('t-2', 'Card two', 'done', 'e-1'),
  task('t-3', 'Card three', 'todo', 'e-2'),
  task('t-loose', 'Unparented card', 'todo'),
];

/** What the fan-out handlers were asked, in order. */
interface EpicCalls {
  work: [string, number | WorkEpicOptions][];
  pause: string[];
  resume: [string, Partial<WorkEpicOptions> | undefined][];
}

function epicCalls(): EpicCalls {
  return { work: [], pause: [], resume: [] };
}

/** A `DispatchProjectData` stub carrying only what BoardView and its layouts read. */
function boardData(
  tasks: TaskDoc[] = TASKS,
  extras: {
    progress?: EpicProgress[];
    calls?: EpicCalls;
    client?: Record<string, unknown>;
  } = {}
): DispatchProjectData {
  const calls = extras.calls ?? epicCalls();
  return {
    config: testConfig,
    client: extras.client ?? {},
    portLoading: false,
    portError: false,
    tasksLoading: false,
    tasks,
    tasksIncludingArchived: tasks,
    archivedTasks: [],
    showArchived: false,
    setShowArchived: () => {},
    epics: EPICS,
    epicProgressById: new Map(
      (extras.progress ?? []).map((p) => [p.epicId, p])
    ),
    readyIds: new Set<string>(['t-1']),
    blockedIds: new Set<string>(),
    runs: [],
    latestRunByTaskId: new Map(),
    liveRunStateByTaskId: new Map(),
    attentionByTaskId: new Map(),
    fixLoops: new Map(),
    mergeQueue: null,
    handleMergeAllReady: async () => {},
    moveTaskStatus: async () => {},
    handleUpdate: async () => {},
    handleDispatch: async () => {},
    handleWorkEpic: (id: string, opts: number | WorkEpicOptions) => {
      calls.work.push([id, opts]);
      return Promise.resolve();
    },
    handlePauseEpic: (id: string) => {
      calls.pause.push(id);
      return Promise.resolve();
    },
    handleResumeEpic: (id: string, opts?: Partial<WorkEpicOptions>) => {
      calls.resume.push([id, opts]);
      return Promise.resolve();
    },
    handleStopEpic: async () => {},
    handleLandEpic: async () => {},
  } as unknown as DispatchProjectData;
}

function session(
  state: EpicSession['state'],
  overrides: Partial<EpicSession> = {}
): EpicSession {
  return {
    epicId: 'e-1',
    concurrency: 3,
    executor: 'claude',
    state,
    maxSpendUsd: 60,
    maxRuns: 20,
    startedAt: '2026-09-20T00:00:00.000Z',
    startedBy: null,
    scope: 'plan',
    updatedAt: '2026-09-20T00:00:00.000Z',
    active: state === 'active',
    ...overrides,
  };
}

/** Progress for `e-1` with one queued child under `session`, or no session at all. */
function progress(sessionState: EpicSession['state'] | null): EpicProgress {
  return {
    epicId: 'e-1',
    active: sessionState === 'active',
    session: sessionState === null ? null : session(sessionState),
    spend: {
      settledUsd: 12,
      liveCount: 0,
      estimatedLiveUsd: 0,
      runsStarted: 2,
      maxSpendUsd: 60,
      maxRuns: 20,
    },
    children: [
      {
        id: 't-1',
        title: 'Card one',
        status: 'todo',
        phase: 'queued',
        wave: 1,
        openFindings: 0,
      },
    ],
    waves: [],
    liveRuns: [],
  };
}

const noop = () => {};
const shellActions = {
  openTask: noop,
  openThread: noop,
  peekTask: noop,
  openCreateTask: noop,
  createPreset: null,
  closeCreateTask: noop,
  openPalette: noop,
  toggleSidebar: noop,
  sidebarHidden: false,
  openOverseer: noop,
  setProjectView: noop,
  setGlobalView: noop,
  openShortcuts: noop,
  copyTaskId: noop,
} satisfies ShellActions;

/** The project root the saved views and favorites persist under. */
const ROOT = '/proj';
const SAVED_VIEWS_KEY = `dispatch:saved-views:${ROOT}`;
const FAVORITES_KEY = `dispatch:favorites:${ROOT}`;

// App's saved-views instance, so the header's tabs, star and dialog work against real
// storage.
function SavedViewsHost({ children }: { children: ReactNode }) {
  const api = useSavedViews(ROOT);
  return <SavedViewsProvider value={api}>{children}</SavedViewsProvider>;
}

function Providers({
  savedViews = true,
  children,
}: {
  savedViews?: boolean;
  children: ReactNode;
}) {
  const inner = <TooltipProvider>{children}</TooltipProvider>;
  return (
    <ShellActionsProvider value={shellActions}>
      {savedViews ? <SavedViewsHost>{inner}</SavedViewsHost> : inner}
    </ShellActionsProvider>
  );
}

function view(
  mode: TasksViewMode = 'board',
  options: {
    data?: DispatchProjectData;
    focusEpic?: FocusEpicRequest | null;
    onSelectTask?: (taskId: string) => void;
    onNewTask?: () => void;
    /** `false` mounts without App's saved-views provider, as the dev harness does. */
    savedViews?: boolean;
  } = {}
) {
  return (
    <Providers savedViews={options.savedViews}>
      <BoardView
        data={options.data ?? boardData()}
        mode={mode}
        projectName="Dispatch"
        focusEpic={options.focusEpic}
        onSelectTask={options.onSelectTask ?? noop}
        onNewTask={options.onNewTask ?? noop}
        onPlanWork={noop}
      />
    </Providers>
  );
}

function mount(onSelectTask: (taskId: string) => void = noop) {
  return render(view('board', { onSelectTask }));
}

// A popover/menu positions itself a microtask after mount (floating-ui), so anything that
// opens one is fired — and its contents clicked — inside an async `act` that lets it settle.
async function settle(work: () => void) {
  await act(async () => {
    work();
    await Promise.resolve();
  });
}

// A header verb clears its busy flag after its handler settles, and the dialog's confirm
// closes it a tick later; drain the queue before asserting on either.
async function settleTick(work: () => void) {
  await act(async () => {
    work();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function dialogTitle(): string | null {
  return (
    document.querySelector('[data-slot=dialog-title]')?.textContent ?? null
  );
}

/** A card's own root element — the keydown target a real keypress has. */
function cardRoot(title: string): HTMLElement {
  const root = screen
    .getByText(title)
    .closest<HTMLElement>('[aria-roledescription="draggable"]');
  if (root === null) throw new Error(`no card rendered for ${title}`);
  return root;
}

function pressNav(key: 'j' | 'k' | 'Enter', on: HTMLElement) {
  fireEvent.keyDown(on, { key });
}

/** The card the roving cursor is on, by the text it renders. */
function focusedCardText(): string {
  const card = screen
    .getAllByRole('button')
    .find((el) => el.getAttribute('data-focused') === 'true');
  return (card?.textContent ?? '').replace(/\s+/g, ' ');
}

/** The one element matching `selector`, or a thrown error naming it. */
function el(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
}

function header(): HTMLElement {
  return el('[data-slot=page-header]');
}

function storedDisplay(): Record<string, unknown> {
  return JSON.parse(
    window.localStorage.getItem(TASKS_DISPLAY_STORAGE_KEY) ?? '{}'
  ) as Record<string, unknown>;
}

beforeEach(() => {
  // Collapse state is session-scoped, and `cleanup()` does not clear storage — without this a
  // lane collapsed by one test would start the next one folded up.
  window.sessionStorage.clear();
  window.localStorage.clear();
});

// The lane-behavior tests below exercise the board with epic lanes; the default is the flat
// kanban, so they seed the display pref the Display popover would write.
function enableEpicLanes() {
  window.localStorage.setItem(
    TASKS_DISPLAY_STORAGE_KEY,
    JSON.stringify({ subGrouping: 'epic' })
  );
}

/** A stored view: done tasks, on the list layout. */
const BLOCKED_URGENT = {
  id: 'v-1',
  name: 'Blocked urgent',
  filters: {
    join: 'and',
    clauses: [{ facet: 'status', op: 'is', values: ['done'] }],
  },
  display: { layout: 'list' },
  createdAt: '2026-09-20T00:00:00.000Z',
};

function seedView() {
  window.localStorage.setItem(
    SAVED_VIEWS_KEY,
    JSON.stringify([BLOCKED_URGENT])
  );
}

function storedViews(): { id: string; name: string; filters: unknown }[] {
  return JSON.parse(window.localStorage.getItem(SAVED_VIEWS_KEY) ?? '[]') as {
    id: string;
    name: string;
    filters: unknown;
  }[];
}

function tabNames(): string[] {
  return screen.getAllByRole('tab').map((t) => t.textContent ?? '');
}

test('the header is two rows: Project › Tasks with ghost actions, then view tabs and the triad', () => {
  mount();
  const rows = header().querySelectorAll('[data-slot=page-header-row]');
  expect(rows).toHaveLength(2);
  expect(
    header().querySelector('[data-slot=page-header-crumb]')?.textContent
  ).toBe('Dispatch›Tasks');
  const plan = screen.getByRole('button', { name: 'Plan work…' });
  expect(plan.dataset['variant']).toBe('ghost');
  expect(
    screen.getByRole('button', { name: 'Merge all ready (0)' }).dataset[
      'variant'
    ]
  ).toBe('ghost');
  // New task left the header — it lives on the sidebar pencil and `c`.
  expect(screen.queryByRole('button', { name: 'New task' })).toBeNull();
  // No saved views yet: the three layout tabs and nothing else.
  expect(tabNames()).toEqual(['Board', 'List', 'Milestones', 'Branches']);
  expect(screen.getByRole('tab', { name: 'Board' }).dataset['active']).toBe(
    'true'
  );
  // The star sits between the crumb and the actions; with no view up it offers to save one.
  const row1 = header().querySelector('[data-slot=page-header-row]');
  const star = within(row1 as HTMLElement).getByLabelText('Favorite this view');
  expect(star.previousElementSibling?.getAttribute('data-slot')).toBe(
    'page-header-crumb'
  );
  expect(screen.queryByRole('button', { name: 'Save view…' })).toBeNull();
  const triad = el('[data-slot=header-icon-triad]');
  expect(within(triad).getByLabelText('Filter')).not.toBeNull();
  expect(within(triad).getByLabelText('Display')).not.toBeNull();
  expect(within(triad).getByLabelText('Group by epic')).not.toBeNull();
});

test('without the saved-views provider there is no star and no view tab', () => {
  seedView();
  render(view('board', { savedViews: false }));
  expect(screen.queryByLabelText(/Favorite/)).toBeNull();
  expect(tabNames()).toEqual(['Board', 'List', 'Milestones', 'Branches']);
});

test('a saved view is a fourth tab that applies its filters and display when picked', () => {
  seedView();
  mount();
  expect(tabNames()).toEqual([
    'Board',
    'List',
    'Milestones',
    'Branches',
    'Blocked urgent',
  ]);
  const tab = screen.getByRole('tab', { name: 'Blocked urgent' });
  expect(tab.querySelector('svg')).not.toBeNull();
  expect(tab.dataset['active']).toBeUndefined();
  fireEvent.click(tab);
  expect(tab.dataset['active']).toBe('true');
  expect(
    screen.getByRole('tab', { name: 'List' }).dataset['active']
  ).toBeUndefined();
  // Its filter and its list layout are on, and persisted like any other change.
  expect(
    document.querySelector('[data-slot=filter-chip]')?.textContent
  ).toContain('Done');
  expect(document.querySelector('[data-slot=list-row]')).not.toBeNull();
  expect(storedDisplay()['layout']).toBe('list');
  expect(screen.queryByRole('button', { name: 'Update view' })).toBeNull();
  // Drifting from the view offers Update view, which rewrites the stored snapshot.
  fireEvent.click(screen.getByRole('button', { name: 'Remove Status filter' }));
  fireEvent.click(screen.getByRole('button', { name: 'Update view' }));
  expect(storedViews()[0]?.filters).toEqual({ join: 'and', clauses: [] });
  expect(screen.queryByRole('button', { name: 'Update view' })).toBeNull();
  // A layout tab leaves the view.
  fireEvent.click(screen.getByRole('tab', { name: 'Board' }));
  expect(tab.dataset['active']).toBeUndefined();
  expect(screen.getByRole('tab', { name: 'Board' }).dataset['active']).toBe(
    'true'
  );
});

test('Save view… snapshots the active filters into storage and selects the view', async () => {
  window.localStorage.setItem(
    TASK_FILTERS_V2_STORAGE_KEY,
    JSON.stringify({
      join: 'and',
      clauses: [{ facet: 'status', op: 'is', values: ['done'] }],
    })
  );
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Save view…' }));
  fireEvent.change(screen.getByLabelText('View name'), {
    target: { value: 'Done only' },
  });
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  });
  const [saved] = storedViews();
  expect(saved?.name).toBe('Done only');
  expect(saved?.filters).toEqual({
    join: 'and',
    clauses: [{ facet: 'status', op: 'is', values: ['done'] }],
  });
  expect(tabNames()).toEqual([
    'Board',
    'List',
    'Milestones',
    'Branches',
    'Done only',
  ]);
  expect(screen.getByRole('tab', { name: 'Done only' }).dataset['active']).toBe(
    'true'
  );
  // Now that a view is up, the header offers the view menu instead of Save view….
  expect(screen.queryByRole('button', { name: 'Save view…' })).toBeNull();
  expect(screen.getByLabelText('View options')).not.toBeNull();
});

// App keeps the provider up and unmounts the page for a task's full view; `page(false)` is
// that trip away, `api` the rail/palette's handle on the store while it is away.
function pageGate() {
  let api: SavedViewsApi | null = null;
  function Capture() {
    api = useSavedViewsContext();
    return null;
  }
  const page = (show: boolean) => (
    <Providers>
      <Capture />
      {show ? (
        <BoardView
          data={boardData()}
          mode="board"
          projectName="Dispatch"
          onSelectTask={noop}
          onNewTask={noop}
          onPlanWork={noop}
        />
      ) : null}
    </Providers>
  );
  return { page, api: () => api };
}

test('coming back to the board keeps the edits made on top of the active view', () => {
  seedView();
  const { page } = pageGate();
  const { rerender } = render(page(true));
  fireEvent.click(screen.getByRole('tab', { name: 'Blocked urgent' }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove Status filter' }));
  expect(screen.getByRole('button', { name: 'Update view' })).not.toBeNull();
  rerender(page(false));
  rerender(page(true));
  // Still on the view, still drifted from it — the remount did not reset the filter.
  expect(
    screen.getByRole('tab', { name: 'Blocked urgent' }).dataset['active']
  ).toBe('true');
  expect(
    document.querySelector('[data-slot=filter-chip]')?.textContent ?? null
  ).toBeNull();
  expect(screen.queryByRole('button', { name: 'Update view' })).not.toBeNull();
  // Leaving the view and picking it again from the tabs is a fresh apply.
  fireEvent.click(screen.getByRole('tab', { name: 'Board' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Blocked urgent' }));
  expect(
    document.querySelector('[data-slot=filter-chip]')?.textContent
  ).toContain('Done');
});

test('a view picked while the board is away applies when it mounts', () => {
  seedView();
  const { page, api } = pageGate();
  const { rerender } = render(page(false));
  act(() => {
    api()?.selectView('v-1');
  });
  rerender(page(true));
  expect(
    screen.getByRole('tab', { name: 'Blocked urgent' }).dataset['active']
  ).toBe('true');
  expect(
    document.querySelector('[data-slot=filter-chip]')?.textContent
  ).toContain('Done');
  expect(document.querySelector('[data-slot=list-row]')).not.toBeNull();
  expect(storedDisplay()['layout']).toBe('list');
});

test('the star favorites the active view', () => {
  seedView();
  mount();
  fireEvent.click(screen.getByRole('tab', { name: 'Blocked urgent' }));
  const star = screen.getByLabelText('Favorite view');
  expect(star.dataset['active']).toBeUndefined();
  fireEvent.click(star);
  expect(
    JSON.parse(window.localStorage.getItem(FAVORITES_KEY) ?? '[]')
  ).toEqual([{ kind: 'view', id: 'v-1' }]);
  const lit = screen.getByLabelText('Unfavorite view');
  expect(lit.dataset['active']).toBe('true');
  fireEvent.click(lit);
  expect(
    JSON.parse(window.localStorage.getItem(FAVORITES_KEY) ?? '[]')
  ).toEqual([]);
});

test('the view menu renames and deletes the active view', async () => {
  seedView();
  mount();
  fireEvent.click(screen.getByRole('tab', { name: 'Blocked urgent' }));
  await settle(() => {
    fireEvent.click(screen.getByLabelText('View options'));
  });
  expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
    'Rename…',
    'Favorite',
    'Delete view',
  ]);
  await settle(() => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
  });
  const name = screen.getByLabelText<HTMLInputElement>('View name');
  expect(name.value).toBe('Blocked urgent');
  fireEvent.change(name, { target: { value: 'Shipped' } });
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  });
  expect(storedViews()[0]?.name).toBe('Shipped');
  expect(tabNames()).toContain('Shipped');
  await settle(() => {
    fireEvent.click(screen.getByLabelText('View options'));
  });
  await settle(() => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete view' }));
  });
  expect(storedViews()).toEqual([]);
  expect(tabNames()).toEqual(['Board', 'List', 'Milestones', 'Branches']);
});

test('the view tabs switch the layout and remember it; the mode prop is only the opening one', () => {
  render(view('board'));
  expect(screen.queryByText('Card one')).not.toBeNull();
  expect(document.querySelector('[data-slot=list-row]')).toBeNull();

  fireEvent.click(screen.getByRole('tab', { name: 'List' }));
  expect(document.querySelector('[data-slot=list-row]')).not.toBeNull();
  expect(document.querySelector('[data-slot=task-card]')).toBeNull();
  expect(window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)).toBe('list');
  expect(storedDisplay()['layout']).toBe('list');

  fireEvent.click(screen.getByRole('tab', { name: 'Milestones' }));
  expect(screen.getByRole('grid', { name: 'Milestones' })).not.toBeNull();
  // Milestones always groups by milestone, so the lane toggle has nothing to do there.
  expect(screen.getByLabelText('Group by epic').hasAttribute('disabled')).toBe(
    true
  );
  // The triad is still present.
  expect(screen.getByLabelText('Filter')).not.toBeNull();
  expect(screen.getByLabelText('Display')).not.toBeNull();

  // Branches: one git-log graph per milestone, persisted like the other tabs; it too has
  // only the milestone grouping, so the lane toggle stays greyed out.
  fireEvent.click(screen.getByRole('tab', { name: 'Branches' }));
  expect(screen.getByRole('grid', { name: 'Branches' })).not.toBeNull();
  expect(screen.queryByRole('grid', { name: 'Milestones' })).toBeNull();
  expect(document.querySelector('[data-slot=branch-gutter]')).not.toBeNull();
  // Unfiltered, every task has a line — the baseline the filter test below narrows from.
  expect(
    Array.from(document.querySelectorAll('[data-slot=branch-line-title]')).map(
      (r) => r.textContent
    )
  ).toEqual(expect.arrayContaining(['Card one', 'Card two', 'Card three']));
  expect(window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)).toBe('branches');
  expect(storedDisplay()['layout']).toBe('branches');
  expect(screen.getByLabelText('Group by epic').hasAttribute('disabled')).toBe(
    true
  );
  expect(screen.getByLabelText('Filter')).not.toBeNull();
  expect(screen.getByLabelText('Display')).not.toBeNull();
});

test('a remembered branches layout opens on the branch graph', () => {
  window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, 'branches');
  render(view('board'));
  expect(screen.getByRole('grid', { name: 'Branches' })).not.toBeNull();
  expect(document.querySelector('[data-slot=task-card]')).toBeNull();
  expect(screen.getByRole('tab', { name: 'Branches' }).dataset['active']).toBe(
    'true'
  );
});

// The regression this guards: the cursor's order was built from the unsorted task list while
// the columns rendered `sortTasks` order, so j jumped around a column instead of walking it.
test('j walks a column in its displayed (priority) order, not data order', () => {
  const opened: string[] = [];
  const tasks = [
    task('t-low', 'Low card', 'todo', null, 'task', 'low'),
    task('t-urgent', 'Urgent card', 'todo', null, 'task', 'urgent'),
    task('t-high', 'High card', 'todo', null, 'task', 'high'),
  ];
  render(
    view('board', {
      data: boardData(tasks),
      onSelectTask: (taskId) => opened.push(taskId),
    })
  );
  const column = el('[data-slot=board-column]');
  expect(
    Array.from(column.querySelectorAll('[data-slot=task-card]')).map((card) =>
      card.textContent?.replace(/\s+/g, ' ')
    )
  ).toEqual([
    expect.stringContaining('Urgent card'),
    expect.stringContaining('High card'),
    expect.stringContaining('Low card'),
  ]);
  const anchor = cardRoot('Low card');
  pressNav('j', anchor);
  expect(focusedCardText()).toContain('Urgent card');
  pressNav('j', anchor);
  expect(focusedCardText()).toContain('High card');
  pressNav('Enter', cardRoot('High card'));
  expect(new Set(opened)).toEqual(new Set(['t-high']));
});

// The board's `d` (and a card's Dispatch) go through the optimistic path like the Cockpit's:
// the card moves at once and the board stays put. A card that is not ready ignores `d`.
test('d dispatches the focused ready card in place', () => {
  const sent: [string, unknown][] = [];
  const data = {
    ...boardData(),
    handleDispatch: (id: string, _e?: string, _m?: string, opts?: unknown) => {
      sent.push([id, opts]);
      return Promise.resolve();
    },
  } as DispatchProjectData;
  render(view('board', { data }));
  const anchor = cardRoot('Card one');

  pressNav('j', anchor);
  while (!focusedCardText().includes('Card one')) pressNav('j', anchor);
  fireEvent.keyDown(anchor, { key: 'd' });
  expect(sent).toEqual([['t-1', { optimistic: true }]]);

  pressNav('j', anchor);
  expect(focusedCardText()).not.toContain('Card one');
  fireEvent.keyDown(anchor, { key: 'd' });
  expect(sent).toHaveLength(1);
});

// A click on a card's Dispatch focuses the card first. The cursor used to follow the card
// to its new column, and focusing it there scrolled the board away from where you clicked.
test('a card’s Dispatch hands the cursor to the card that takes its place', () => {
  function Live() {
    const [tasks, setTasks] = useState(TASKS);
    const data = {
      ...boardData(tasks),
      // The optimistic move: the card leaves Todo for Done at once.
      handleDispatch: (id: string) => {
        setTasks((prev) =>
          prev.map((t) =>
            t.meta.id === id ? { ...t, meta: { ...t.meta, status: 'done' } } : t
          )
        );
        return Promise.resolve();
      },
    } as DispatchProjectData;
    return view('board', { data });
  }
  render(<Live />);
  const dispatch = within(cardRoot('Card one')).getByRole('button', {
    name: /Dispatch/,
  });
  act(() => dispatch.focus());
  expect(focusedCardText()).toContain('Card one');
  fireEvent.click(dispatch);
  expect(focusedCardText()).toContain('Card three');
  expect(focusedCardText()).not.toContain('Card one');
});

// Every card takes the visible column list. A dispatch moves a column's count but not the
// columns, so a rebuilt copy of the same list used to redraw every card on the board.
test('a card moving between shown columns redraws only that card', () => {
  const renders = new Map<string, number>();
  // A card reads its reading's `splitProbability` once per render, and nothing else does.
  const counted = (id: string) =>
    ({
      level: 3,
      label: 'clear',
      confidence: 1,
      get splitProbability() {
        renders.set(id, (renders.get(id) ?? 0) + 1);
        return 0;
      },
    }) as ReadinessReading;
  const data = {
    ...boardData(),
    readinessById: new Map(
      TASKS.filter((t) => t.meta.kind === 'task').map((t) => [
        t.meta.id,
        counted(t.meta.id),
      ])
    ),
  } as DispatchProjectData;
  const { rerender } = render(view('board', { data }));
  expect(screen.queryByText('Card three')).not.toBeNull();
  renders.clear();

  // t-3 leaves todo for done; both columns were already showing.
  const moved = TASKS.map((t) =>
    t.meta.id === 't-3' ? { ...t, meta: { ...t.meta, status: 'done' } } : t
  );
  rerender(
    view('board', {
      data: { ...data, tasks: moved, tasksIncludingArchived: moved },
    })
  );
  expect([...renders.keys()]).toEqual(['t-3']);
});

// The regression this guards: `initial` used to win over storage, so App's never-updated
// `mode` prop put the board back on Board every time the view remounted (a trip to Git and
// back) after the user had chosen List.
test('a remembered layout wins over the opening mode prop', () => {
  window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, 'list');
  render(view('board'));
  expect(document.querySelector('[data-slot=list-row]')).not.toBeNull();
  expect(document.querySelector('[data-slot=task-card]')).toBeNull();
  expect(screen.getByRole('tab', { name: 'List' }).dataset['active']).toBe(
    'true'
  );
});

test('the board opens on the flat kanban with every task in a status column', () => {
  mount();
  expect(screen.queryByText('Card one')).not.toBeNull();
  expect(screen.queryByText('Card three')).not.toBeNull();
  expect(screen.queryByText('Unparented card')).not.toBeNull();
  // Empty columns stay hidden until Display › Show empty groups.
  const columns = Array.from(
    document.querySelectorAll('[data-slot=board-column-header]')
  ).map((el) => el.textContent);
  expect(columns).toEqual(['Todo3', 'Done1']);
});

test('the Display popover writes the display prefs and the board follows', async () => {
  mount();
  await settle(() => {
    fireEvent.click(screen.getByLabelText('Display'));
  });
  const popover = el('[data-slot=display-popover]');
  expect(popover.className).toContain('w-[260px]');
  expect(
    within(popover).getByRole('radiogroup', { name: 'Layout' })
  ).not.toBeNull();
  expect(
    within(popover).getByRole('button', { name: 'Grouping' }).textContent
  ).toContain('Status');
  // The board's columns are always status: the Grouping menu lists the rest greyed out.
  await settle(() => {
    fireEvent.click(within(popover).getByRole('button', { name: 'Grouping' }));
  });
  const groupings = screen.getAllByRole('menuitemradio');
  expect(groupings.map((item) => item.textContent)).toEqual([
    'Status',
    'Epic',
    'Milestone',
    'Assignee',
    'Priority',
    'No grouping',
  ]);
  expect(
    groupings.map((item) => item.getAttribute('aria-disabled') === 'true')
  ).toEqual([false, true, true, true, true, true]);
  await settle(() => {
    fireEvent.keyDown(groupings[0], { key: 'Escape' });
  });
  await settle(() => {
    fireEvent.click(
      within(popover).getByRole('button', { name: 'Sub-grouping' })
    );
  });
  expect(
    screen.getAllByRole('menuitemradio').map((item) => item.textContent)
  ).toEqual(['No grouping', 'Epic', 'Assignee', 'Priority']);
  await settle(() => {
    fireEvent.keyDown(screen.getAllByRole('menuitemradio')[0], {
      key: 'Escape',
    });
  });
  await settle(() => {
    fireEvent.click(
      within(popover).getByRole('switch', {
        name: 'Show empty groups',
      })
    );
  });
  expect(storedDisplay()['showEmptyGroups']).toBe(true);
  const columns = Array.from(
    document.querySelectorAll('[data-slot=board-column-header]')
  ).map((el) => el.textContent);
  expect(columns).toHaveLength(testConfig.statuses.length);
  // The property chips toggle the card anatomy.
  const chips = el('[data-slot=display-properties]');
  await settle(() => {
    fireEvent.click(within(chips).getByRole('button', { name: 'ID' }));
  });
  expect((storedDisplay()['properties'] as string[]).includes('id')).toBe(
    false
  );
  expect(
    document.querySelector('[data-slot=task-card-meta]')?.textContent
  ).not.toContain('t-1');
});

// The segmented control mirrors the header tabs, so Branches is a fourth cell with the
// branch icon; on that layout Grouping is greyed out exactly as on Milestones.
test('the Display popover switches to Branches and greys out Grouping there', async () => {
  mount();
  await settle(() => {
    fireEvent.click(screen.getByLabelText('Display'));
  });
  const popover = el('[data-slot=display-popover]');
  const layout = within(popover).getByRole('radiogroup', { name: 'Layout' });
  const cells = within(layout).getAllByRole('radio');
  expect(cells.map((cell) => cell.textContent)).toEqual([
    'Board',
    'List',
    'Milestones',
    'Branches',
  ]);
  const branches = within(layout).getByRole('radio', { name: 'Branches' });
  expect(branches.querySelector('svg.lucide-git-branch')).not.toBeNull();
  expect(
    within(popover)
      .getByRole('button', { name: 'Grouping' })
      .hasAttribute('disabled')
  ).toBe(false);
  await settle(() => {
    fireEvent.click(branches);
  });
  expect(branches.getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('grid', { name: 'Branches' })).not.toBeNull();
  expect(window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)).toBe('branches');
  expect(storedDisplay()['layout']).toBe('branches');
  // Greyed out and pinned to the grouping the layout draws, not the list's remembered one.
  const grouping = within(popover).getByRole('button', { name: 'Grouping' });
  expect(grouping.hasAttribute('disabled')).toBe(true);
  expect(grouping.textContent).toContain('Milestone');
});

test('the Filter menu lists facets and applies a Status chip under the header', async () => {
  mount();
  expect(
    screen
      .getByLabelText('Filter')
      .querySelector('[data-slot=filter-active-dot]')
  ).toBeNull();
  await settle(() => {
    fireEvent.click(screen.getByLabelText('Filter'));
  });
  const menu = el('[data-slot=filter-menu]');
  expect(menu.className).toContain('w-[180px]');
  expect(screen.getByPlaceholderText('Add filter…')).not.toBeNull();
  const facets = within(menu)
    .getAllByRole('menuitem')
    .map((el) => el.textContent);
  expect(facets).toEqual([
    'AI filter',
    'Status',
    'Priority',
    'Assignee',
    'Labels',
    'Epic',
    'Milestone',
    'Run state',
    'Created',
    'Updated',
  ]);
  await settle(() => {
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Status' }));
  });
  await settle(() => {
    fireEvent.click(
      within(menu).getByRole('menuitemcheckbox', {
        name: /Done/,
      })
    );
  });
  const chip = document.querySelector('[data-slot=filter-chip]');
  // The facet, operator and value are separate spans with no whitespace between them.
  expect(chip?.textContent).toContain('Status');
  expect(chip?.textContent).toContain('Done');
  expect(
    screen
      .getByLabelText('Filter')
      .querySelector('[data-slot=filter-active-dot]')
  ).not.toBeNull();
  // The board narrows to the matching cards; the column set does not.
  expect(screen.queryByText('Card one')).toBeNull();
  expect(screen.queryByText('Card two')).not.toBeNull();
  expect(
    JSON.parse(window.localStorage.getItem(TASK_FILTERS_V2_STORAGE_KEY) ?? '')
  ).toEqual({
    join: 'and',
    clauses: [{ facet: 'status', op: 'is', values: ['done'] }],
  });
  fireEvent.click(screen.getByRole('button', { name: 'Remove Status filter' }));
  expect(document.querySelector('[data-slot=filter-chip]')).toBeNull();
  expect(screen.queryByText('Card one')).not.toBeNull();
});

test('the Filter menu walks with arrow keys, and Escape in a facet steps back', async () => {
  mount();
  await settle(() => {
    fireEvent.click(screen.getByLabelText('Filter'));
  });
  const menu = el('[data-slot=filter-menu]');
  const facets = within(menu).getAllByRole('menuitem');
  facets[0].focus();
  fireEvent.keyDown(within(menu).getByRole('menu'), { key: 'ArrowDown' });
  expect(document.activeElement).toBe(facets[1]);
  fireEvent.keyDown(within(menu).getByRole('menu'), { key: 'ArrowUp' });
  expect(document.activeElement).toBe(facets[0]);
  fireEvent.keyDown(within(menu).getByRole('menu'), { key: 'End' });
  expect(document.activeElement).toBe(facets[facets.length - 1]);

  await settle(() => {
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Created' }));
  });
  const picks = within(menu).getAllByRole('menuitemcheckbox');
  expect(picks.map((p) => p.getAttribute('aria-checked'))).not.toContain(
    'true'
  );
  await settle(() => {
    fireEvent.click(
      within(menu).getByRole('menuitemcheckbox', { name: 'In the last week' })
    );
  });
  // A date pick stores a resolved bound, yet its own row reads as the checked one.
  expect(
    within(menu)
      .getAllByRole('menuitemcheckbox')
      .map((p) => [p.textContent, p.getAttribute('aria-checked')])
  ).toEqual([
    ['In the last day', 'false'],
    ['In the last week', 'true'],
    ['In the last month', 'false'],
    ['More than a week ago', 'false'],
    ['More than a month ago', 'false'],
  ]);
  await settle(() => {
    fireEvent.keyDown(within(menu).getByRole('menu'), { key: 'Escape' });
  });
  expect(document.querySelector('[data-slot=filter-menu]')).not.toBeNull();
  expect(within(menu).getByRole('menuitem', { name: 'Status' })).not.toBeNull();
});

test('a v1 chip filter migrates into an applied clause', () => {
  window.localStorage.setItem(
    TASK_FILTERS_STORAGE_KEY,
    JSON.stringify({ statuses: ['todo'], priorities: [] })
  );
  mount();
  const chip = document.querySelector('[data-slot=filter-chip]');
  expect(chip?.textContent).toContain('Status');
  expect(chip?.textContent).toContain('Todo');
  expect(screen.queryByText('Card two')).toBeNull();
});

test('the filter applies to the list too', () => {
  window.localStorage.setItem(
    TASK_FILTERS_V2_STORAGE_KEY,
    JSON.stringify({
      join: 'and',
      clauses: [{ facet: 'status', op: 'is', values: ['done'] }],
    })
  );
  render(view('list'));
  const rows = Array.from(
    document.querySelectorAll('[data-slot=list-row]')
  ).map((r) => r.textContent);
  expect(rows.some((r) => r?.includes('Card two'))).toBe(true);
  expect(rows.some((r) => r?.includes('Card one'))).toBe(false);
});

// The branch graph lays out only the tasks that pass the clauses, so a filtered-out task
// loses its line (and its edges) rather than the whole milestone vanishing. (A `todo`
// filter, not `done`: a milestone left with only done children counts as finished and
// starts folded, which would hide the lines for a different reason.)
test('the filter narrows the branch graph the same way', () => {
  window.localStorage.setItem(
    TASK_FILTERS_V2_STORAGE_KEY,
    JSON.stringify({
      join: 'and',
      clauses: [{ facet: 'status', op: 'is', values: ['todo'] }],
    })
  );
  render(view('branches'));
  expect(screen.getByRole('grid', { name: 'Branches' })).not.toBeNull();
  const titles = Array.from(
    document.querySelectorAll('[data-slot=branch-line-title]')
  ).map((r) => r.textContent);
  expect(titles).toContain('Card one');
  expect(titles).toContain('Card three');
  expect(titles).not.toContain('Card two');
});

// The AI row hands the sentence to the daemon; a facet it invents is dropped on the way in.
test('the AI filter turns a sentence into clauses, keeping only the valid ones', async () => {
  const asked: string[] = [];
  render(
    view('board', {
      data: boardData(TASKS, {
        client: {
          aiFilterTasks: (sentence: string) => {
            asked.push(sentence);
            return Promise.resolve({
              join: 'and',
              clauses: [
                { facet: 'status', op: 'is', values: ['done'] },
                { facet: 'bogus', op: 'is', values: ['x'] },
              ],
            });
          },
        },
      }),
    })
  );
  await settle(() => {
    fireEvent.click(screen.getByLabelText('Filter'));
  });
  const menu = el('[data-slot=filter-menu]');
  await settle(() => {
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'AI filter' }));
  });
  fireEvent.change(within(menu).getByLabelText('AI filter'), {
    target: { value: 'urgent tasks nobody is on' },
  });
  await settleTick(() => {
    fireEvent.keyDown(within(menu).getByLabelText('AI filter'), {
      key: 'Enter',
    });
  });
  expect(asked).toEqual(['urgent tasks nobody is on']);
  const chips = document.querySelectorAll('[data-slot=filter-chip]');
  expect(chips).toHaveLength(1);
  expect(chips[0]?.textContent).toContain('Done');
  expect(screen.queryByText('Card one')).toBeNull();
  expect(
    JSON.parse(window.localStorage.getItem(TASK_FILTERS_V2_STORAGE_KEY) ?? '')
  ).toEqual({
    join: 'and',
    clauses: [{ facet: 'status', op: 'is', values: ['done'] }],
  });
});

test('the side-panel toggle groups the board into epic lanes', () => {
  mount();
  expect(document.querySelector('[data-slot=group-header]')).toBeNull();
  fireEvent.click(screen.getByLabelText('Group by epic'));
  expect(
    Array.from(document.querySelectorAll('[data-slot=group-header-name]')).map(
      (el) => el.textContent
    )
  ).toEqual(['Payments epic', 'Search epic', 'No epic']);
  expect(storedDisplay()['subGrouping']).toBe('epic');
  expect(storedDisplay()['grouping']).toBe('status');
  expect(screen.getByLabelText('Ungroup epics').dataset['active']).toBe('true');
  fireEvent.click(screen.getByLabelText('Ungroup epics'));
  expect(storedDisplay()['subGrouping']).toBe('none');
  expect(document.querySelector('[data-slot=group-header]')).toBeNull();
});

// Display › Sub-grouping › Priority: one lane per priority, and the cursor walks a lane's
// columns before moving to the next lane — not one status column across every lane.
test('priority sub-grouping draws lane headers that j/k walk lane by lane', () => {
  window.localStorage.setItem(
    TASKS_DISPLAY_STORAGE_KEY,
    JSON.stringify({ subGrouping: 'priority' })
  );
  const tasks = [
    task('t-u1', 'Urgent todo', 'todo', null, 'task', 'urgent'),
    task('t-u2', 'Urgent done', 'done', null, 'task', 'urgent'),
    task('t-l', 'Low todo', 'todo', null, 'task', 'low'),
  ];
  render(view('board', { data: boardData(tasks) }));
  expect(
    Array.from(document.querySelectorAll('[data-slot=group-header-name]')).map(
      (el) => el.textContent
    )
  ).toEqual(['Urgent', 'Low']);
  expect(
    Array.from(document.querySelectorAll('[data-lane-key]')).map((s) =>
      s.getAttribute('data-lane-key')
    )
  ).toEqual(['priority:urgent', 'priority:low']);
  const anchor = cardRoot('Urgent todo');
  pressNav('j', anchor);
  expect(focusedCardText()).toContain('Urgent todo');
  pressNav('j', anchor);
  expect(focusedCardText()).toContain('Urgent done');
  pressNav('j', anchor);
  expect(focusedCardText()).toContain('Low todo');
  pressNav('k', anchor);
  expect(focusedCardText()).toContain('Urgent done');
  // Folding a lane takes its cards out of the walk.
  fireEvent.click(screen.getByRole('button', { name: 'Urgent' }));
  const low = cardRoot('Low todo');
  pressNav('k', low);
  expect(focusedCardText()).toContain('Low todo');
});

test('j walks the cards lane by lane, and Enter opens the one it stopped on', () => {
  enableEpicLanes();
  const opened: string[] = [];
  mount((taskId) => opened.push(taskId));
  const anchor = cardRoot('Card one');

  pressNav('j', anchor);
  expect(focusedCardText()).toContain('Card one');
  pressNav('j', anchor);
  expect(focusedCardText()).toContain('Card two');
  pressNav('j', anchor);
  expect(focusedCardText()).toContain('Card three');
  pressNav('k', anchor);
  expect(focusedCardText()).toContain('Card two');

  pressNav('Enter', cardRoot('Card two'));
  expect(opened.length).toBeGreaterThan(0);
  expect(new Set(opened)).toEqual(new Set(['t-2']));
});

// The regression this guards: an order built from all the project's tasks would walk the cursor
// into a folded-up lane, moving real DOM focus to a card nobody can see.
test('j/k skip the cards a collapsed epic is hiding', () => {
  enableEpicLanes();
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Payments epic' }));
  const anchor = cardRoot('Card three');

  pressNav('j', anchor);
  expect(focusedCardText()).toContain('Card three');
  pressNav('j', anchor);
  expect(focusedCardText()).toContain('Unparented card');
});

test('a collapsed lane stays collapsed after switching to the list and back', () => {
  enableEpicLanes();
  render(view('board'));
  fireEvent.click(screen.getByRole('button', { name: 'Payments epic' }));
  expect(screen.queryByText('Card one')).toBeNull();

  fireEvent.click(screen.getByRole('tab', { name: 'List' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Board' }));
  expect(screen.queryByText('Card one')).toBeNull();
  expect(screen.queryByText('Card three')).not.toBeNull();
});

test('`f` on the board opens the filter menu', async () => {
  mount();
  await settle(() => {
    fireEvent.keyDown(cardRoot('Card one'), { key: 'f' });
  });
  expect(document.querySelector('[data-slot=filter-menu]')).not.toBeNull();
});

test('an empty project shows the Linear empty state with New task and Plan work', () => {
  let created = 0;
  render(
    view('board', { data: boardData([]), onNewTask: () => (created += 1) })
  );
  const empty = document.querySelector('[data-slot=empty-state]');
  expect(empty?.textContent).toContain('No tasks yet');
  const newTask = screen.getByRole('button', { name: /New task/ });
  expect(newTask.querySelector('kbd')?.textContent).toBe('C');
  fireEvent.click(newTask);
  expect(created).toBe(1);
  expect(screen.getAllByRole('button', { name: 'Plan work…' })).toHaveLength(2);
});

test('a focusEpic request switches to the milestones layout and hands it the request', () => {
  render(
    view('board', {
      focusEpic: { epicId: 'e-1', dispatch: true, nonce: 1 },
    })
  );
  // The open dialog hides the page from the accessibility tree, so read the tab directly.
  expect(el('[role=tab][data-active=true]').textContent).toBe('Milestones');
  // The milestones layout served it: the fan-out dialog is open for that epic, once.
  expect(dialogTitle()).toBe('Send agents · Payments epic');
  expect(document.querySelectorAll('[data-slot=dialog-title]')).toHaveLength(1);
});

test('leaving the milestones layout retires the request so returning does not replay it', () => {
  render(
    view('board', {
      focusEpic: { epicId: 'e-1', dispatch: true, nonce: 1 },
    })
  );
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(dialogTitle()).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Board' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Milestones' }));
  expect(dialogTitle()).toBeNull();
});

test('epic lane headers roll up under a mirrored workflow on their first load', () => {
  enableEpicLanes();
  const epics = [
    task('e-1', 'Payments epic', 'In Progress', null, 'epic'),
    task('e-2', 'Search epic', 'In Progress', null, 'epic'),
  ];
  const tasks = [
    ...epics,
    task('t-1', 'Card one', 'QA', 'e-1'),
    task('t-2', 'Card two', 'Done', 'e-1'),
    task('t-3', 'Card three', 'Done', 'e-2'),
    task('t-4', 'Card four', 'Canceled', 'e-2'),
  ];
  const finished: EpicProgress = {
    ...progress('complete'),
    epicId: 'e-2',
    children: [
      { ...progress(null).children[0], id: 't-3', status: 'Done' },
      { ...progress(null).children[0], id: 't-4', status: 'Canceled' },
    ],
  };
  // Config lands after the tasks. The open project's model is left unset: it is set in an
  // effect after the render config lands in, and any later board render (a resize, a
  // cursor move) would mask a lane still reading it, so the lanes must read config alone.
  function App({ config }: { config: DispatchProjectData['config'] }) {
    const data = {
      ...boardData(tasks, { progress: [finished] }),
      epics,
      config,
    } as DispatchProjectData;
    return view('board', { data });
  }
  const { rerender } = render(<App config={null} />);
  act(() => rerender(<App config={linearWorkflowConfig} />));

  const lanes = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-slot=board-lane-header] [data-slot=group-header]'
    )
  );
  expect(lanes).toHaveLength(2);
  // Payments rolls up to its review-role status, not the built-in `ready`.
  expect(lanes[0]?.querySelector('[aria-label="Status: QA"]')).not.toBeNull();
  expect(lanes[0]?.style.getPropertyValue('--tint')).toBe(
    'var(--status-progress)'
  );
  // Search's children are all Done or Canceled: it reads done and offers Land.
  expect(lanes[1]?.querySelector('[aria-label="Status: Done"]')).not.toBeNull();
  expect(lanes[1]?.style.getPropertyValue('--tint')).toBe('var(--status-done)');
  expect(within(lanes[1]).getByRole('button', { name: 'Land' })).toBeTruthy();
});

test('a lane header’s Send agents… confirms through the options-shaped handleWorkEpic', async () => {
  enableEpicLanes();
  const calls = epicCalls();
  render(view('board', { data: boardData(TASKS, { calls }) }));
  // One per epic lane; the Payments lane comes first.
  fireEvent.click(screen.getAllByRole('button', { name: 'Send agents…' })[0]);
  expect(dialogTitle()).toBe('Send agents · Payments epic');
  await settleTick(() => {
    fireEvent.click(screen.getByRole('button', { name: /Send \d+ agents?/ }));
  });
  // The config's concurrency, and the dialog's defaults: $10 × 2 tasks, one run each.
  expect(calls.work).toEqual([
    ['e-1', { concurrency: 3, maxSpendUsd: 20, maxRuns: 2 }],
  ]);
  expect(dialogTitle()).toBeNull();
});

test('Pause and Resume on a lane pass straight through to the hook', async () => {
  enableEpicLanes();
  const calls = epicCalls();
  const { rerender } = render(
    view('board', {
      data: boardData(TASKS, { calls, progress: [progress('active')] }),
    })
  );
  await settleTick(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  });
  expect(calls.pause).toEqual(['e-1']);

  rerender(
    view('board', {
      data: boardData(TASKS, { calls, progress: [progress('paused')] }),
    })
  );
  await settleTick(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  });
  expect(calls.resume).toEqual([['e-1', undefined]]);
});

test('Raise ceiling… opens the dialog in raise mode, pre-filled, and confirms through handleResumeEpic', async () => {
  enableEpicLanes();
  const calls = epicCalls();
  render(
    view('board', {
      data: boardData(TASKS, { calls, progress: [progress('paused')] }),
    })
  );
  fireEvent.click(screen.getByRole('button', { name: 'Raise ceiling…' }));
  expect(dialogTitle()).toBe('Raise ceiling · Payments epic');
  expect(screen.getByLabelText('Spend ceiling').getAttribute('value')).toBe(
    '60'
  );
  expect(screen.getByLabelText('Max runs').getAttribute('value')).toBe('20');
  fireEvent.change(screen.getByLabelText('Spend ceiling'), {
    target: { value: '120' },
  });
  await settleTick(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Raise ceiling' }));
  });
  expect(calls.resume).toEqual([
    ['e-1', { concurrency: 3, maxSpendUsd: 120, maxRuns: 20 }],
  ]);
  expect(calls.work).toHaveLength(0);
  expect(dialogTitle()).toBeNull();
});
