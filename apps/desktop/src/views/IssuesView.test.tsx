import type {
  TaskDoc,
  TaskKind,
  UpdatePatch,
} from '@dispatch-foo/core/browser';
import { statusModelOf } from '@dispatch-foo/core/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { type ReactNode, useState } from 'react';

import { PeopleProvider } from '../components/people/PeopleContext';
import { testConfig } from '../components/settings/fixtures.test-helper';
import {
  type DeepLinkActions,
  DeepLinkProvider,
} from '../components/shell/DeepLinkContext';
import {
  SavedViewsProvider,
  useSavedViewsContext,
} from '../components/shell/SavedViewsContext';
import {
  type CreateTaskPreset,
  type ShellActions,
  ShellActionsProvider,
} from '../components/shell/ShellActionsContext';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { type SavedViewsApi, useSavedViews } from '../hooks/useSavedViews';
import { needsYou } from '../lib/needsYou';
import { taskDoc } from '../lib/taskDoc.test-helper';
import type { TasksPreset } from '../lib/tasksPresets';
import type { TaskStatusCounts } from '../lib/taskStatus';
import type { TasksMode, TasksPage } from '../lib/twoViews';
import {
  TWO_VIEWS_TASKS_DISPLAY,
  writeTwoViewsDisplay,
} from '../lib/twoViewsTasksPrefs';
import { TooltipProvider } from '@/ui/tooltip';

// The graph layout's Live view mounts the task page, whose Review mode pulls in
// the Pierre diff; its worker import only Vite resolves.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
}));

const { IssuesView } = await import('./IssuesView');

// The Issues hub end to end in happy-dom: the grouped table, its pickers, the
// row menu, the selection and bulk bar, the keys, the presets, the chips, the
// layouts and the saved views, with the window's data stubbed.

const ME = 'human:wyat';

function task(
  id: string,
  title: string,
  status: string,
  parent: string | null = null,
  kind: TaskKind = 'task',
  assignee = 'none',
  overrides: Partial<TaskDoc['meta']> = {}
): TaskDoc {
  return taskDoc({
    id,
    title,
    status,
    kind,
    parent,
    assignee,
    created: '2026-08-10T00:00:00.000Z',
    updated: '2026-08-10T00:00:00.000Z',
    ...overrides,
  });
}

const EPICS = [
  task('e-1', 'Payments', 'todo', null, 'milestone'),
  task('e-2', 'Billing', 'todo', null, 'milestone'),
];
const TASKS = [
  ...EPICS,
  task('t-1', 'Card one', 'todo', 'e-1', 'task', ME, { labels: ['ui'] }),
  task('t-2', 'Card two', 'done', 'e-1'),
  task('t-3', 'Loose card', 'todo'),
];

/** Every write the view asked the window for, in order. */
interface Log {
  moved: [string, string][];
  updated: [string, UpdatePatch][];
  dispatched: {
    taskId: string;
    batch: boolean | undefined;
    optimistic?: boolean;
  }[];
  presets: CreateTaskPreset[];
  peeked: string[];
  copied: string[];
  linked: string[];
  opened: string[];
}

function newLog(): Log {
  return {
    moved: [],
    updated: [],
    dispatched: [],
    presets: [],
    peeked: [],
    copied: [],
    linked: [],
    opened: [],
  };
}

// Only what the hub, its table, board and side groups read; no client, so the
// daemon-backed queries stay off.
function dataWith(
  log: Log,
  overrides: Partial<DispatchProjectData> = {}
): DispatchProjectData {
  return {
    config: testConfig,
    client: null,
    port: undefined,
    me: ME,
    myTier: 'operator',
    people: [],
    executors: null,
    linearLinks: {},
    portLoading: false,
    portError: false,
    tasksLoading: false,
    tasks: TASKS,
    tasksIncludingArchived: TASKS,
    archivedTasks: [],
    showArchived: false,
    setShowArchived: () => {},
    epics: EPICS,
    epicProgressById: new Map(),
    readyIds: new Set<string>(['t-1', 't-3']),
    blockedIds: new Set<string>(),
    runs: [],
    inbox: [],
    repoPrs: [],
    presence: [],
    latestRunByTaskId: new Map(),
    liveRunStateByTaskId: new Map(),
    attentionByTaskId: new Map(),
    readinessById: new Map(),
    fixLoops: new Map(),
    mergeQueue: null,
    messageAccess: { canDecide: true, canMessage: false, explanation: null },
    scopeDecide: {
      enabled: true,
      notice: null,
      explanation: null,
      restart: null,
    },
    moveTaskStatus: (id: string, status: string) => {
      log.moved.push([id, status]);
      return Promise.resolve();
    },
    handleUpdate: (id: string, patch: UpdatePatch) => {
      log.updated.push([id, patch]);
      return Promise.resolve();
    },
    handleDispatch: (
      taskId: string,
      _executor?: string,
      _model?: string,
      opts?: { batch?: boolean; optimistic?: boolean }
    ) => {
      log.dispatched.push({
        taskId,
        batch: opts?.batch,
        ...(opts?.optimistic !== undefined && { optimistic: opts.optimistic }),
      });
      return Promise.resolve();
    },
    handlePauseEpic: async () => {},
    handleResumeEpic: async () => {},
    handleStopEpic: async () => {},
    handleLandEpic: async () => {},
    handleWorkEpic: async () => {},
    ...overrides,
  } as unknown as DispatchProjectData;
}

const counts: TaskStatusCounts = {
  buckets: {
    'need-you': 1,
    failed: 0,
    working: 0,
    review: 0,
    landing: 0,
    ready: 2,
    draft: 0,
    blocked: 0,
  },
  open: 2,
  landed: 1,
  total: 3,
};

const ROOT = '/proj';
const SAVED_VIEWS_KEY = `dispatch:saved-views:${ROOT}`;
const FAVORITES_KEY = `dispatch:favorites:${ROOT}`;
const LIST: TasksPage = { kind: 'list' };
const noop = () => {};

function shellWith(log: Log): ShellActions {
  return {
    openTask: noop,
    openThread: noop,
    peekTask: (id) => log.peeked.push(id),
    openCreateTask: (preset) => log.presets.push(preset ?? {}),
    createPreset: null,
    closeCreateTask: noop,
    openPalette: noop,
    openOverseer: noop,
    setProjectView: noop,
    setGlobalView: noop,
    openShortcuts: noop,
    copyTaskId: (id) => log.copied.push(id),
  };
}

/** The saved-views api the test drives, as the palette's Open view would. */
let api: SavedViewsApi | null = null;
function Capture() {
  api = useSavedViewsContext();
  return null;
}

function SavedViewsHost({ children }: { children: ReactNode }) {
  const value = useSavedViews(ROOT);
  return <SavedViewsProvider value={value}>{children}</SavedViewsProvider>;
}

interface HarnessProps {
  data: DispatchProjectData;
  log: Log;
  initialMode?: TasksMode;
  page?: TasksPage;
}

// App's side of the view: the mode and preset live in its reducer.
function Harness({
  data,
  log,
  initialMode = 'list',
  page = LIST,
}: HarnessProps) {
  const [mode, setMode] = useState<TasksMode>(initialMode);
  const [preset, setPreset] = useState<TasksPreset>('all');
  return (
    <IssuesView
      data={data}
      needs={needsYou([], ME)}
      decided={[]}
      counts={counts}
      page={page}
      mode={mode}
      onModeChange={setMode}
      preset={preset}
      onPreset={setPreset}
      presetContext={{ bucketOf: () => null, starred: new Set(), me: ME }}
      onSelectTask={(id) => log.opened.push(id)}
      onNewTask={noop}
      onOpenRef={noop}
      onOpenDecision={noop}
      renderPage={() => null}
      onClosePage={noop}
      onNewProject={noop}
      onDispatchTask={() => Promise.resolve()}
      onDispatchFailed={noop}
      onPeekTask={noop}
      onOpenPr={noop}
      onOpenDoc={noop}
      onOpenAllDocs={noop}
      projectKey={ROOT}
      speechByTask={new Map()}
      composer={null}
    />
  );
}

interface MountOptions {
  data?: Partial<DispatchProjectData>;
  initialMode?: TasksMode;
  page?: TasksPage;
  deepLink?: DeepLinkActions | null;
  people?: { ref: string; name: string; placeholder?: boolean }[];
}

function mount(options: MountOptions = {}) {
  const log = newLog();
  const data = dataWith(log, options.data);
  let view: ReactNode = (
    <Harness
      data={data}
      log={log}
      initialMode={options.initialMode}
      page={options.page}
    />
  );
  if (options.deepLink !== undefined && options.deepLink !== null) {
    view = <DeepLinkProvider value={options.deepLink}>{view}</DeepLinkProvider>;
  }
  if (options.people !== undefined) {
    view = (
      <PeopleProvider people={options.people} me={ME}>
        {view}
      </PeopleProvider>
    );
  }
  const result = render(
    <QueryClientProvider client={new QueryClient()}>
      <ShellActionsProvider value={shellWith(log)}>
        <SavedViewsHost>
          <TooltipProvider>
            <Capture />
            {view}
          </TooltipProvider>
        </SavedViewsHost>
      </ShellActionsProvider>
    </QueryClientProvider>
  );
  return { ...result, log, data };
}

/** The group headers' names, in order. */
function groupNames(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-nav-item="group"] button[data-nav-target]'
    )
  ).map((button) => button.getAttribute('aria-label') ?? '');
}

/** The row ids drawn, in order. */
function rowIds(): string[] {
  return Array.from(document.querySelectorAll('li[data-row-id]')).map(
    (row) => row.getAttribute('data-row-id') ?? ''
  );
}

/** A row's title link: its focus target and where the row keys land. */
function rowLink(title: string): HTMLElement {
  return screen.getByRole('link', { name: title });
}

function rowOf(title: string): HTMLElement {
  const row = rowLink(title).closest<HTMLElement>('li[data-row-id]');
  if (row === null) throw new Error(`no row for ${title}`);
  return row;
}

/** The open picker's options (every popover is a dialog with a listbox). */
function options(): HTMLElement[] {
  return screen.getAllByRole('option');
}

function optionNamed(name: string): HTMLElement {
  const option = options().find(
    (o) => o.querySelector('[dir="auto"]')?.textContent === name
  );
  if (option === undefined) {
    throw new Error(
      `no option ${name} among ${options()
        .map((o) => o.textContent)
        .join(', ')}`
    );
  }
  return option;
}

// A popover positions itself a frame after it mounts; opening or driving one
// runs inside an async act that lets that settle.
async function settle(work: () => void) {
  await act(async () => {
    work();
    await Promise.resolve();
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  api = null;
});
afterEach(cleanup);

// ---- groups, rows, presets, chips ---------------------------------------------

test('the list stays grouped by milestone by default, with a row per task', () => {
  mount();
  expect(groupNames().slice(0, 2)).toEqual(['Payments', 'No milestone']);
  expect(rowIds()).toEqual(['t-1', 't-2', 't-3']);
  // The id is the key cell; the label rides as a chip; the status is a cell picker.
  expect(rowOf('Card one').textContent).toContain('t-1');
  expect(rowOf('Card one').textContent).toContain('ui');
  expect(
    within(rowOf('Card one')).getByRole('button', { name: /^t-1 status/ })
  ).not.toBeNull();
  // The view keeps its test id for the e2e specs.
  expect(screen.getByTestId('tasks-view')).not.toBeNull();
});

test('the preset tabs narrow the rows: Mine keeps only my work', () => {
  mount();
  const tabs = screen.getByRole('navigation', { name: 'Presets' });
  expect(
    within(tabs).getByRole('link', { name: /^Needs you/ }).textContent
  ).toBe('Needs you1');
  fireEvent.click(within(tabs).getByRole('link', { name: /^Mine/ }));
  expect(rowIds()).toEqual(['t-1']);
  expect(
    within(tabs)
      .getByRole('link', { name: /^Mine/ })
      .getAttribute('aria-current')
  ).toBe('page');
});

test('the view menu offers the presets too', () => {
  mount();
  fireEvent.click(screen.getByTestId('tasks-preset'));
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Mine' }));
  expect(rowIds()).toEqual(['t-1']);
});

test('a stored filter narrows the list and shows as a chip that removes', () => {
  window.localStorage.setItem(
    'dispatch:two-views-tasks-filters-v1',
    JSON.stringify({
      join: 'and',
      clauses: [{ facet: 'status', op: 'is', values: ['done'] }],
    })
  );
  mount();
  expect(rowIds()).toEqual(['t-2']);
  const chips = screen.getByRole('group', { name: 'Filters' });
  expect(chips.textContent).toContain('Status');
  expect(chips.textContent).toContain('Done');
  fireEvent.click(
    within(chips).getByRole('button', { name: 'Remove status filter' })
  );
  expect(rowIds()).toEqual(['t-1', 't-2', 't-3']);
  expect(screen.queryByRole('group', { name: 'Filters' })).toBeNull();
});

test('a chip reopens its values; toggling one edits the clause', async () => {
  window.localStorage.setItem(
    'dispatch:two-views-tasks-filters-v1',
    JSON.stringify({
      join: 'and',
      clauses: [{ facet: 'status', op: 'is', values: ['done'] }],
    })
  );
  mount();
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Edit status filter' }));
  });
  await settle(() => {
    fireEvent.click(optionNamed('Todo'));
  });
  expect(rowIds()).toEqual(['t-1', 't-2', 't-3']);
});

test('the search box narrows by title, id and label before grouping', () => {
  mount();
  const search = screen.getByRole('searchbox', { name: 'Search issues' });
  fireEvent.change(search, { target: { value: 'loose' } });
  expect(rowIds()).toEqual(['t-3']);
  fireEvent.change(search, { target: { value: 'ui' } });
  expect(rowIds()).toEqual(['t-1']);
  fireEvent.change(search, { target: { value: 'zzz' } });
  expect(screen.getByText('No tasks match')).not.toBeNull();
});

test('display prefs drive the grouping and which cells a row shows', () => {
  writeTwoViewsDisplay({
    ...TWO_VIEWS_TASKS_DISPLAY,
    grouping: 'epic',
    properties: new Set(['status']),
  });
  mount();
  expect(groupNames()[0]).toBe('Payments');
  expect(screen.getByRole('button', { name: /^t-1 status/ })).not.toBeNull();
  expect(screen.queryByRole('button', { name: /^t-1 priority/ })).toBeNull();
});

test('a project with no tasks says so instead of blaming a filter', () => {
  mount({ data: { tasks: [], tasksIncludingArchived: [], epics: [] } });
  expect(screen.getByText('No tasks yet')).not.toBeNull();
});

test('the + on a group pre-fills the creator with its container', () => {
  const { log } = mount();
  fireEvent.click(screen.getByRole('button', { name: 'New task in Payments' }));
  expect(log.presets).toEqual([{ epic: 'e-1' }]);
});

test('collapsing a group keeps its header so it can be expanded again', () => {
  mount();
  const toggle = screen.getByRole('button', { name: 'Payments' });
  fireEvent.click(toggle);
  expect(rowIds()).toEqual(['t-3']);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle);
  expect(rowIds()).toEqual(['t-1', 't-2', 't-3']);
});

// ---- cell pickers ----------------------------------------------------------------

test('a state cell change calls moveTaskStatus', async () => {
  const { log } = mount();
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: /^t-1 status/ }));
  });
  await settle(() => {
    fireEvent.click(optionNamed('Done'));
  });
  expect(log.moved).toEqual([['t-1', 'done']]);
});

test('priority and assignee cell changes patch the task', async () => {
  const { log } = mount();
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: /^t-1 priority/ }));
  });
  await settle(() => {
    fireEvent.click(optionNamed('Urgent'));
  });
  expect(log.updated).toEqual([['t-1', { priority: 'urgent' }]]);

  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: /^t-3 assignee/ }));
  });
  // Agents get their own glyph; the pool reads "Any agent".
  await settle(() => {
    fireEvent.click(optionNamed('Any agent'));
  });
  expect(log.updated[1]).toEqual(['t-3', { assignee: 'agent' }]);
});

test('m on a row whose milestone column is hidden opens the picker in its … slot', async () => {
  const { log } = mount();
  await settle(() => {
    fireEvent.keyDown(rowLink('Loose card'), { key: 'm' });
  });
  await settle(() => {
    fireEvent.click(optionNamed('Billing'));
  });
  expect(log.updated).toEqual([['t-3', { parent: 'e-2' }]]);
});

test('a request-tier window renders plain cells, no checkboxes and no drag', () => {
  mount({ data: { myTier: 'request' } });
  expect(screen.queryByRole('button', { name: /^t-1 status/ })).toBeNull();
  expect(screen.queryByLabelText('Select t-1')).toBeNull();
  expect(document.querySelector('[data-drag]')).toBeNull();
  expect(rowOf('Card one').textContent).toContain('Todo');
});

// ---- the row menu ------------------------------------------------------------------

test('a right-click opens the row menu, and Archive patches archivedAt', async () => {
  const { log } = mount();
  await settle(() => {
    fireEvent.contextMenu(rowOf('Card one'), { clientX: 40, clientY: 50 });
  });
  const labels = options().map(
    (o) => o.querySelector('[dir="auto"]')?.textContent
  );
  expect(labels).toEqual([
    'Status…',
    'Priority…',
    'Assignee…',
    'Milestone…',
    'Open',
    'Quick look',
    'Dispatch…',
    'Copy id',
    'Archive',
    'Drop',
  ]);
  await settle(() => {
    fireEvent.click(optionNamed('Archive'));
  });
  expect(log.updated).toEqual([
    ['t-1', { archivedAt: expect.stringMatching(/^\d{4}-/) }],
  ]);
});

test('the row menu copies a link only with a deep-link provider, and drops through the model', async () => {
  const linked: string[] = [];
  const { log } = mount({
    deepLink: { copyTaskLink: (id) => linked.push(id) },
  });
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Actions for t-3' }));
  });
  await settle(() => {
    fireEvent.click(optionNamed('Copy link'));
  });
  expect(linked).toEqual(['t-3']);
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Actions for t-3' }));
  });
  await settle(() => {
    fireEvent.click(optionNamed('Drop'));
  });
  // Drop lands on the model's dropped role (the built-in one under an untyped config).
  expect(log.moved).toEqual([['t-3', statusModelOf(testConfig).roles.dropped]]);
});

test('the Assignee picker never offers the unknown-Linear-user placeholder', async () => {
  mount({
    people: [
      { ref: 'human:wyat', name: 'Wyat Soule' },
      {
        ref: 'human:linear-user',
        name: 'Unknown Linear user',
        placeholder: true,
      },
    ],
    data: {
      people: [
        { ref: 'human:wyat', name: 'Wyat Soule' },
        {
          ref: 'human:linear-user',
          name: 'Unknown Linear user',
          placeholder: true,
        },
      ] as unknown as DispatchProjectData['people'],
    },
  });
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: /^t-3 assignee/ }));
  });
  const labels = options().map(
    (o) => o.querySelector('[dir="auto"]')?.textContent
  );
  expect(labels).toEqual(['Unassigned', 'Wyat Soule', 'Any agent']);
});

// ---- selection and the bulk bar ---------------------------------------------------

/** Ticks the named rows, opens Actions on the bar and confirms the dispatch dialog. */
async function bulkDispatch(ids: string[]) {
  for (const id of ids) fireEvent.click(screen.getByLabelText(`Select ${id}`));
  expect(screen.getByRole('toolbar', { name: /selected/ })).not.toBeNull();
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
  });
  await settle(() => {
    fireEvent.click(optionNamed(`Dispatch ${ids.length} ready…`));
  });
  const dialog = within(screen.getByRole('dialog', { name: /Send agents/ }));
  fireEvent.click(dialog.getByRole('button', { name: /^Send \d+ agents?$/ }));
}

// The bulk bar loops handleDispatch; marking the batch keeps the app from
// following each run's Chat in turn.
test('a bulk dispatch of several tasks does not follow any of them', async () => {
  const { log } = mount();
  await bulkDispatch(['t-1', 't-3']);
  await waitFor(() => expect(log.dispatched.length).toBe(2));
  expect(log.dispatched.map((d) => d.taskId)).toEqual(['t-1', 't-3']);
  expect(log.dispatched.every((d) => d.batch === true)).toBe(true);
});

test('a bulk dispatch of one task still follows it', async () => {
  const { log } = mount();
  await bulkDispatch(['t-3']);
  await waitFor(() => expect(log.dispatched.length).toBe(1));
  expect(log.dispatched[0]?.batch).toBe(false);
});

test('a bulk status change moves every selected task and clears the selection', async () => {
  const { log } = mount();
  fireEvent.click(screen.getByLabelText('Select t-1'));
  fireEvent.click(screen.getByLabelText('Select t-3'));
  expect(screen.getByRole('toolbar', { name: /2 selected/ })).not.toBeNull();
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Status' }));
  });
  await settle(() => {
    fireEvent.click(optionNamed('In Progress'));
  });
  await waitFor(() => expect(log.moved.length).toBe(2));
  expect(log.moved).toEqual([
    ['t-1', 'in-progress'],
    ['t-3', 'in-progress'],
  ]);
  await waitFor(() =>
    expect(screen.queryByRole('toolbar', { name: /selected/ })).toBeNull()
  );
});

test('a change to twenty or more selected rows asks first', async () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    task(`m-${i}`, `Many ${i}`, 'todo')
  );
  const { log } = mount({
    data: { tasks: many, tasksIncludingArchived: many, epics: [] },
  });
  fireEvent.click(screen.getByLabelText('Select all 20 shown issues'));
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
  });
  await settle(() => {
    fireEvent.click(optionNamed('Archive'));
  });
  expect(log.updated).toEqual([]);
  const bar = screen.getByRole('toolbar', { name: /selected/ });
  expect(bar.textContent).toContain('Archive on 20 issues?');
  fireEvent.click(within(bar).getByRole('button', { name: 'Archive · 20' }));
  await waitFor(() => expect(log.updated.length).toBe(20));
});

// ---- keys ------------------------------------------------------------------------------

test('Enter and o open the row beside the list, Space quick-looks it, ⌘C copies its id', () => {
  const { log } = mount();
  const link = rowLink('Card one');
  fireEvent.keyDown(link, { key: 'Enter' });
  fireEvent.keyDown(link, { key: 'o' });
  expect(log.opened).toEqual(['t-1', 't-1']);
  fireEvent.keyDown(link, { key: ' ' });
  expect(log.peeked).toEqual(['t-1']);
  fireEvent.keyDown(link, { key: 'c', metaKey: true });
  expect(log.copied).toEqual(['t-1']);
});

test('clicking a row title opens that task', () => {
  const { log } = mount();
  fireEvent.click(rowLink('Loose card'));
  expect(log.opened).toEqual(['t-3']);
});

test('s opens the focused row’s status picker, and only that one', async () => {
  mount();
  await settle(() => {
    fireEvent.keyDown(rowLink('Card one'), { key: 's' });
  });
  expect(
    screen
      .getByRole('button', { name: /^t-1 status/ })
      .getAttribute('aria-expanded')
  ).toBe('true');
  expect(
    screen
      .getByRole('button', { name: /^t-3 status/ })
      .getAttribute('aria-expanded')
  ).toBe('false');
  // Keys typed inside the open picker never reach the row.
  const popup = screen.getByRole('dialog', { name: 't-1 status' });
  fireEvent.keyDown(within(popup).getByRole('combobox'), { key: 'j' });
  expect(document.activeElement).not.toBe(rowLink('Card two'));
});

test('d dispatches the focused ready row in place, and never a row that is not ready', async () => {
  const { log } = mount();
  fireEvent.keyDown(rowLink('Card two'), { key: 'd' });
  fireEvent.keyDown(rowLink('Loose card'), { key: 'd' });
  await waitFor(() => expect(log.dispatched.length).toBe(1));
  expect(log.dispatched).toEqual([
    { taskId: 't-3', batch: undefined, optimistic: true },
  ]);
});

test('x selects the focused row and Escape clears the selection', () => {
  mount();
  const link = rowLink('Card one');
  fireEvent.keyDown(link, { key: 'x' });
  expect(rowOf('Card one').getAttribute('data-selected')).toBe('true');
  expect(screen.getByRole('toolbar', { name: /1 selected/ })).not.toBeNull();
  fireEvent.keyDown(link, { key: 'Escape' });
  expect(screen.queryByRole('toolbar', { name: /selected/ })).toBeNull();
});

test('a focused row stays the first the list offers to the keyboard', () => {
  mount();
  expect(document.activeElement).toBe(rowLink('Card one'));
});

// ---- layouts and saved views -------------------------------------------------------

test('the layout control offers List, Board and Graph, and Board draws the columns', () => {
  mount();
  const control = screen.getByRole('radiogroup', { name: 'Tasks layout' });
  expect(control.textContent).toBe('ListBoardGraph');
  fireEvent.click(screen.getByRole('radio', { name: 'Board' }));
  expect(screen.getByTestId('board-pane')).not.toBeNull();
  expect(
    document.querySelectorAll('[data-slot=board-column]').length
  ).toBeGreaterThan(0);
});

test('group by person regroups the list by assignee and back', () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Group by person' }));
  expect(groupNames()).not.toContain('Payments');
  fireEvent.click(
    screen.getByRole('button', { name: 'Stop grouping by person' })
  );
  expect(groupNames().slice(0, 2)).toEqual(['Payments', 'No milestone']);
});

test('selecting a saved view applies its filters and layout', () => {
  window.localStorage.setItem(
    SAVED_VIEWS_KEY,
    JSON.stringify([
      {
        id: 'v-1',
        name: 'Done on the board',
        filters: {
          join: 'and',
          clauses: [{ facet: 'status', op: 'is', values: ['done'] }],
        },
        display: { layout: 'board' },
        createdAt: '2026-09-20T00:00:00.000Z',
      },
    ])
  );
  mount();
  act(() => api?.selectView('v-1'));
  expect(screen.getByTestId('board-pane')).not.toBeNull();
  expect(
    screen.getByRole('radio', { name: 'Board' }).getAttribute('aria-checked')
  ).toBe('true');
  expect(screen.getByTestId('tasks-preset').textContent).toBe(
    'view: Done on the board'
  );
});

test('the view menu lists the presets, then starred views, then saved views', () => {
  window.localStorage.setItem(
    SAVED_VIEWS_KEY,
    JSON.stringify([
      {
        id: 'v-1',
        name: 'Starred one',
        filters: { join: 'and', clauses: [] },
        display: { layout: 'list' },
        createdAt: '2026-09-20T00:00:00.000Z',
      },
      {
        id: 'v-2',
        name: 'Plain one',
        filters: { join: 'and', clauses: [] },
        display: { layout: 'list' },
        createdAt: '2026-09-20T00:00:00.000Z',
      },
    ])
  );
  window.localStorage.setItem(
    FAVORITES_KEY,
    JSON.stringify([{ kind: 'view', id: 'v-1' }])
  );
  mount();
  fireEvent.click(screen.getByTestId('tasks-preset'));
  const presets = screen
    .getAllByRole('menuitemradio')
    .map((i) => i.textContent);
  expect(presets.slice(0, 2)).toEqual(['All', 'Mine']);
  expect(presets).toContain('Plain one');
  const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
  expect(items[0]).toBe('Starred one');
  expect(items).toContain('Save view…');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Starred one' }));
  expect(api?.activeViewId).toBe('v-1');
});

test('an open task beside the list marks its row current and the pane is a region', () => {
  mount({
    page: {
      kind: 'task',
      taskId: 't-3',
      tab: 'auto',
      runId: null,
      full: false,
    },
  });
  expect(rowOf('Loose card').getAttribute('aria-current')).toBe('true');
  expect(screen.getByRole('region', { name: 'Task' })).not.toBeNull();
});

test('a large list paints whole groups up to 200 rows first and the rest a frame later', async () => {
  // Three milestones of 100 tasks: the first frame draws two whole groups.
  const epics = [1, 2, 3].map((n) =>
    task(`e-${n}`, `Milestone ${n}`, 'todo', null, 'milestone')
  );
  const tasks = [...epics];
  for (let i = 0; i < 300; i++) {
    tasks.push(task(`t-${i}`, `Task ${i}`, 'todo', `e-${(i % 3) + 1}`));
  }
  mount({ data: { tasks, epics } });
  expect(rowIds()).toHaveLength(200);
  expect(groupNames()).toEqual(['Milestone 1', 'Milestone 2']);
  await waitFor(() => expect(rowIds()).toHaveLength(300));
  expect(groupNames()).toEqual(['Milestone 1', 'Milestone 2', 'Milestone 3']);
});
