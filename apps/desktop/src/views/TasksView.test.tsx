import type { TaskDoc } from '@dispatch-foo/core/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test } from 'bun:test';
import { type ReactNode, useState } from 'react';

import { testConfig } from '../components/settings/fixtures.test-helper';
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
import { needsYou } from '../lib/needsYou';
import type { TasksPreset } from '../lib/tasksPresets';
import type { TaskStatusCounts } from '../lib/taskStatus';
import type { TasksMode, TasksPage } from '../lib/twoViews';
import { TasksView } from './TasksView';
import { TooltipProvider } from '@/ui/tooltip';

const ME = 'human:wyat';

function task(
  id: string,
  title: string,
  status: string,
  parent: string | null = null,
  kind = 'task',
  assignee = 'none'
): TaskDoc {
  return {
    meta: {
      id,
      title,
      status,
      kind,
      priority: 'medium',
      parent,
      milestone: null,
      labels: [],
      assignee,
      blockedBy: [],
      writes: [],
      created: '2026-08-10T00:00:00.000Z',
      updated: '2026-08-10T00:00:00.000Z',
    },
    body: '',
  } as unknown as TaskDoc;
}

const EPICS = [task('e-1', 'Payments', 'todo', null, 'epic')];
const TASKS = [
  ...EPICS,
  task('t-1', 'Card one', 'todo', 'e-1', 'task', ME),
  task('t-2', 'Card two', 'done', 'e-1'),
  task('t-3', 'Loose card', 'todo'),
];

// Only what the Tasks view, its list, board and side groups read; no client, so the
// daemon-backed queries stay off.
const data = {
  config: testConfig,
  client: null,
  port: undefined,
  me: ME,
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
  readyIds: new Set<string>(),
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
  moveTaskStatus: async () => {},
  handleUpdate: async () => {},
  handleDispatch: async () => {},
} as unknown as DispatchProjectData;

const counts: TaskStatusCounts = {
  buckets: {
    'need-you': 0,
    failed: 0,
    working: 0,
    review: 0,
    landing: 0,
    ready: 0,
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
const shellActions = {
  openTask: noop,
  openThread: noop,
  peekTask: noop,
  openCreateTask: noop,
  createPreset: null,
  closeCreateTask: noop,
  openPalette: noop,
  openOverseer: noop,
  setProjectView: noop,
  setGlobalView: noop,
  openShortcuts: noop,
  copyTaskId: noop,
} satisfies ShellActions;

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

// App's side of the view: the mode and preset live in its reducer.
function Harness({ initialMode = 'list' }: { initialMode?: TasksMode }) {
  const [mode, setMode] = useState<TasksMode>(initialMode);
  const [preset, setPreset] = useState<TasksPreset>('all');
  return (
    <TasksView
      data={data}
      needs={needsYou([], ME)}
      decided={[]}
      counts={counts}
      page={LIST}
      mode={mode}
      onModeChange={setMode}
      preset={preset}
      onPreset={setPreset}
      presetContext={{ bucketOf: () => null, starred: new Set(), me: ME }}
      onSelectTask={noop}
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
      onOpenNotes={noop}
      projectKey={ROOT}
      speechByTask={new Map()}
      composer={null}
    />
  );
}

function mount(initialMode?: TasksMode) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ShellActionsProvider value={shellActions}>
        <SavedViewsHost>
          <TooltipProvider>
            <Capture />
            <Harness initialMode={initialMode} />
          </TooltipProvider>
        </SavedViewsHost>
      </ShellActionsProvider>
    </QueryClientProvider>
  );
}

function groupNames(): string[] {
  return Array.from(
    screen
      .getByRole('grid', { name: 'Tasks' })
      .querySelectorAll('[data-slot=group-header-name]')
  ).map((g) => g.textContent ?? '');
}

function rowTitles(): string[] {
  return Array.from(document.querySelectorAll('[data-slot=list-row]')).map(
    (r) => r.textContent ?? ''
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  api = null;
});

test('the list stays grouped by milestone by default', () => {
  mount();
  expect(groupNames().slice(0, 2)).toEqual(['Payments', 'No milestone']);
});

test('the layout toggle offers List, Board and Graph, and Board draws the columns', () => {
  mount();
  const toggle = screen.getByRole('group', { name: 'Tasks layout' });
  expect(toggle.textContent).toBe('ListBoardGraph');
  fireEvent.click(screen.getByRole('button', { name: 'Board' }));
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

test('the Mine preset keeps only my work', () => {
  mount();
  fireEvent.click(screen.getByTestId('tasks-preset'));
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Mine' }));
  const rows = rowTitles();
  expect(rows.some((r) => r.includes('Card one'))).toBe(true);
  expect(rows.some((r) => r.includes('Loose card'))).toBe(false);
});

test('a filter applies to the list and shows as a chip', () => {
  window.localStorage.setItem(
    'dispatch:two-views-tasks-filters-v1',
    JSON.stringify({
      join: 'and',
      clauses: [{ facet: 'status', op: 'is', values: ['done'] }],
    })
  );
  mount();
  const rows = rowTitles();
  expect(rows.some((r) => r.includes('Card two'))).toBe(true);
  expect(rows.some((r) => r.includes('Card one'))).toBe(false);
  expect(document.querySelectorAll('[data-slot=filter-chip]')).toHaveLength(1);
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
    screen.getByRole('button', { name: 'Board' }).getAttribute('aria-pressed')
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
