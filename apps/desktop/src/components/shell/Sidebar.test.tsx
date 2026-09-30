import type { DraftRecord } from '@dispatch/client';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'bun:test';

import type { GlobalView, ProjectView } from '../../lib/appNav';
import {
  PROJECT_NAV_VIEWS,
  PROJECT_VIEW_ORDER,
  Sidebar,
  useSidebarCollapsed,
} from './Sidebar';
import { SidebarProvider } from '@/ui/sidebar';

const props = {
  hasActiveProject: true,
  section: 'project' as const,
  projectView: 'inbox' as ProjectView,
  globalView: 'all-agents' as GlobalView,
  switcher: <span>dispatch</span>,
  trafficLightInset: false,
  onOpenPalette: () => {},
  onNewTask: () => {},
  inboxCount: 2,
  overseerPendingCount: 0,
  liveAgentCount: 3,
  drafts: [] as DraftRecord[],
  onOpenDraft: () => {},
  onDismissDraft: () => {},
  onSetProjectView: (_view: ProjectView): void => {},
  onSetGlobalView: (
    _view: GlobalView,
    _options?: { page?: 'integrations' }
  ): void => {},
  liveRail: <div>live-rail-body</div>,
  onQuickCapture: () => {},
};

// The rail reads its hidden state from `SidebarProvider`, so every case mounts through one.
function mount(
  open: boolean,
  overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}
) {
  return render(
    <SidebarProvider open={open} onOpenChange={() => {}}>
      <Sidebar {...props} {...overrides} />
    </SidebarProvider>
  );
}

// Section state persists; every test starts from a fresh rail.
beforeEach(() => {
  window.localStorage.removeItem('dispatch:sidebar-sections');
  window.localStorage.removeItem('dispatch:sidebar-collapsed');
});

function navRows(): string[] {
  return screen
    .getAllByRole('button')
    .filter((b) => b.hasAttribute('data-nav-item'))
    .map((b) => b.getAttribute('data-nav-item') ?? '');
}

test('the exported view order is the ⌘N order App.tsx indexes into', () => {
  // Rail order, which is also ⌘N order: Home, Inbox and Threads, then Work,
  // then the merge queue that leads Runs, then Code — the sections as they
  // render.
  expect(PROJECT_VIEW_ORDER).toEqual([
    'cockpit',
    'inbox',
    'threads',
    'overview',
    'board',
    'projects',
    'live',
    'plans',
    'brain-dump',
    'landing',
    'branches',
    'files',
    'docs',
    'terminals',
    'design',
    'impact',
  ]);
  expect(PROJECT_NAV_VIEWS.map((v) => v.label)).toEqual([
    'Home',
    'Inbox',
    'Threads',
    'Overview',
    'Tasks',
    'Projects',
    'Live',
    'Plans',
    'Notes',
    'Merge queue',
    'Git',
    'Files',
    'Docs',
    'Terminals',
    'Design',
    'Impact',
  ]);
});

test('sections come in Linear order: fixed top group, then Work, Runs, Code, Live agents, Try', () => {
  mount(true);
  expect(navRows()).toEqual([
    'cockpit',
    'inbox',
    'threads',
    'drafts',
    'overseer',
    'overview',
    'board',
    'projects',
    'live',
    'plans',
    'brain-dump',
    'landing',
    'sessions',
    'all-agents',
    'branches',
    'files',
    'docs',
    'terminals',
    'design',
    'impact',
    'try-plan',
    'try-capture',
    'try-linear',
  ]);
  // The headings are sentence-case buttons with a chevron — collapsible.
  for (const heading of ['Work', 'Runs', 'Code', 'Live agents', 'Try']) {
    const button = screen.getByRole('button', { name: heading });
    expect(button.getAttribute('aria-expanded')).toBe('true');
  }
  // The live-agents body is App's `LiveRail`, given a home under its heading.
  expect(screen.getByText('live-rail-body')).toBeTruthy();
  // No Settings row: it lives in the switcher menu and on G S.
  expect(screen.queryByRole('button', { name: /^Settings/ })).toBeNull();
});

test('the Threads row carries what waits on me, with the attention state', () => {
  mount(true, { threadsNeedsYouCount: 2 });
  const row = document.querySelector('[data-nav-item="threads"]');
  expect(row?.textContent).toContain('2');
  // The attention dot, the same one the Inbox row earns.
  expect(row?.querySelector('span.rounded-full')).not.toBeNull();
});

test('a teammate below operator is not shown the host-only rows', () => {
  mount(true, { hideHostViews: true });
  const rows = navRows();
  // A shell and a browser carrying the host's cookies are operator-tier; the
  // rest of Code (reading files and docs, git history, impact) stays.
  expect(rows).not.toContain('terminals');
  expect(rows).not.toContain('design');
  expect(rows).toContain('files');
  expect(rows).toContain('docs');
  expect(rows).toContain('branches');
});

test('the top strip holds the switcher plus search and new-task icon buttons', () => {
  mount(true);
  expect(screen.getByText('dispatch')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy();
  const newTask = screen.getByRole('button', { name: 'New task' });
  expect(newTask.getAttribute('data-filled')).toBe('true');
  // The strip is the window's drag region and clears the traffic lights when asked.
  const strip = document.querySelector('[data-tauri-drag-region]');
  expect(strip).toBeTruthy();
  expect(strip?.className).not.toContain('pl-[76px]');
});

test('the traffic-light inset steps the top strip right', () => {
  mount(true, { trafficLightInset: true });
  const strip = document.querySelector('[data-tauri-drag-region]');
  expect(strip?.className).toContain('pl-[76px]');
});

test('counts are plain text with no keycap hints, no ⌘K footer, no sync text', () => {
  mount(true, { overseerPendingCount: 5 });
  const inbox = screen.getByRole('button', { name: /^Inbox/ });
  expect(inbox.getAttribute('aria-current')).toBe('page');
  expect(within(inbox).getByText('2').tagName).toBe('SPAN');
  expect(within(inbox).getByText('2').className).not.toContain('font-mono');
  expect(
    within(screen.getByRole('button', { name: /^Assistant/ })).getByText('5')
  ).toBeTruthy();
  expect(
    within(screen.getByRole('button', { name: /^All agents/ })).getByText('3')
  ).toBeTruthy();
  expect(screen.queryByText(/⌘/)).toBeNull();
  expect(document.querySelector('kbd')).toBeNull();
  expect(screen.queryByText(/jump anywhere/)).toBeNull();
  expect(screen.queryByText(/today/)).toBeNull();
  expect(screen.queryByText(/Synced|sync/)).toBeNull();
  expect(screen.queryByRole('button', { name: /sidebar/i })).toBeNull();
});

test('rows are 28px and the active one sits on the selected surface', () => {
  mount(true);
  const inbox = screen.getByRole('button', { name: /^Inbox/ });
  expect(inbox.className).toContain('h-7');
  expect(inbox.className).toContain('bg-surface-selected');
  const tasks = screen.getByRole('button', { name: 'Tasks' });
  expect(tasks.className).not.toContain('bg-surface-selected');
});

test('Tasks has no nested Board/List/Milestones rows', () => {
  mount(true, { projectView: 'board' });
  expect(screen.queryByRole('button', { name: 'Board' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'List' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Milestones' })).toBeNull();
});

test('a section heading collapses its rows and the choice persists', () => {
  const first = mount(true);
  fireEvent.click(screen.getByRole('button', { name: 'Runs' }));
  expect(screen.queryByRole('button', { name: /^All agents/ })).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Runs' }).getAttribute('aria-expanded')
  ).toBe('false');
  expect(
    JSON.parse(window.localStorage.getItem('dispatch:sidebar-sections') ?? '{}')
  ).toEqual({ fleet: true });
  first.unmount();

  mount(true);
  expect(screen.queryByRole('button', { name: /^All agents/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Runs' }));
  expect(screen.getByRole('button', { name: /^All agents/ })).toBeTruthy();
});

test('using a Try row does its job and folds the block for next time', () => {
  const views: string[] = [];
  let captures = 0;
  mount(true, {
    onSetProjectView: (v) => {
      views.push(v);
    },
    onQuickCapture: () => {
      captures++;
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Plan work…' }));
  expect(views).toEqual(['plans']);
  expect(screen.queryByRole('button', { name: 'Drop a thought' })).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Try' }).getAttribute('aria-expanded')
  ).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'Try' }));
  fireEvent.click(screen.getByRole('button', { name: 'Drop a thought' }));
  expect(captures).toBe(1);
});

test('project rows and Connect Linear route to the right view', () => {
  const project: string[] = [];
  const global: [string, unknown][] = [];
  mount(true, {
    onSetProjectView: (v) => {
      project.push(v);
    },
    onSetGlobalView: (v, options) => {
      global.push([v, options]);
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Git' }));
  fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
  fireEvent.click(screen.getByRole('button', { name: 'Connect Linear' }));
  expect(project).toEqual(['branches']);
  // Connect Linear lands on Settings › Integrations, not Settings' first page.
  expect(global).toEqual([
    ['sessions', undefined],
    ['settings', { page: 'integrations' }],
  ]);
});

const SAVED_VIEWS = [
  { id: 'v-1', name: 'Blocked urgent' },
  { id: 'v-2', name: 'Mine' },
];

test('saved views nest under Tasks as indented rows and select through onSelectSavedView', () => {
  const selected: string[] = [];
  const project: string[] = [];
  mount(true, {
    savedViews: SAVED_VIEWS,
    onSelectSavedView: (id) => {
      selected.push(id);
    },
    onSetProjectView: (v) => {
      project.push(v);
    },
  });
  const rows = navRows();
  // The saved views sit between Tasks and whatever follows it in Work.
  expect(rows.slice(rows.indexOf('board'), rows.indexOf('board') + 4)).toEqual([
    'board',
    'view-v-1',
    'view-v-2',
    'projects',
  ]);
  const row = screen.getByRole('button', { name: 'Blocked urgent' });
  expect(row.className).toContain('pl-6');
  fireEvent.click(row);
  expect(selected).toEqual(['v-1']);
  // A view row never falls through to the project-view setter.
  expect(project).toEqual([]);
});

test('the active saved view lights its own row, and only on the Tasks page', () => {
  const first = mount(true, {
    savedViews: SAVED_VIEWS,
    activeSavedViewId: 'v-2',
    projectView: 'board',
  });
  expect(
    screen.getByRole('button', { name: 'Mine' }).getAttribute('aria-current')
  ).toBe('page');
  expect(
    screen.getByRole('button', { name: 'Tasks' }).getAttribute('aria-current')
  ).toBeNull();
  first.unmount();

  mount(true, {
    savedViews: SAVED_VIEWS,
    activeSavedViewId: 'v-2',
    projectView: 'plans',
  });
  expect(
    screen.getByRole('button', { name: 'Mine' }).getAttribute('aria-current')
  ).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Plans' }).getAttribute('aria-current')
  ).toBe('page');
});

test('the Favorites section is absent when nothing is starred', () => {
  mount(true, { savedViews: SAVED_VIEWS });
  expect(screen.queryByRole('button', { name: 'Favorites' })).toBeNull();
  expect(navRows().filter((id) => id.startsWith('fav-'))).toEqual([]);
});

test('Favorites lists starred views and tasks above Work and opens them', () => {
  const opened: { kind: string; id: string }[] = [];
  mount(true, {
    favorites: [
      { kind: 'view', id: 'v-1', label: 'Blocked urgent' },
      { kind: 'task', id: 't-9', label: 'Cache the index' },
    ],
    onOpenFavorite: (ref) => {
      opened.push(ref);
    },
  });
  const rows = navRows();
  expect(rows.slice(0, 8)).toEqual([
    'cockpit',
    'inbox',
    'threads',
    'drafts',
    'overseer',
    'fav-view-v-1',
    'fav-task-t-9',
    'overview',
  ]);
  const heading = screen.getByRole('button', { name: 'Favorites' });
  expect(heading.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Blocked urgent' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cache the index' }));
  expect(opened).toEqual([
    { kind: 'view', id: 'v-1' },
    { kind: 'task', id: 't-9' },
  ]);
  fireEvent.click(heading);
  expect(screen.queryByRole('button', { name: 'Cache the index' })).toBeNull();
});

test('the Drafts row counts live drafts and opens the tray', () => {
  const drafts = [
    {
      id: 'd-1',
      state: 'ready',
      prompt: 'add caching',
      questions: [],
      proposal: { tasks: [{ title: 'Cache the index' }] },
      error: null,
      createdAt: '2026-08-04T00:00:00.000Z',
    },
  ] as unknown as DraftRecord[];
  mount(true, { drafts });
  const row = screen.getByRole('button', { name: /^Drafts/ });
  expect(within(row).getByText('1')).toBeTruthy();
  expect(screen.queryByText('Cache the index')).toBeNull();
  fireEvent.click(row);
  expect(screen.getByText('Cache the index')).toBeTruthy();
});

test('the hidden rail collapses to zero width and takes nothing with it', () => {
  mount(false);
  const rail = document.getElementById('dispatch-sidebar');
  expect(rail?.getAttribute('data-state')).toBe('collapsed');
  expect(rail?.className).toContain('w-0');
  expect(rail?.hasAttribute('inert')).toBe(true);
  // No icon strip: the rows are still in the tree (for the width transition) but inert.
  expect(
    screen.getByRole('button', { name: /^Inbox/, hidden: true })
  ).toBeTruthy();
});

// The key and its '1'/'0' encoding are a stored-state contract with every install that already
// has a preference written — a rename or a re-encoding silently expands everyone's rail once.
test('the hidden preference round-trips through its long-standing key', () => {
  function Probe() {
    const [collapsed, setCollapsed] = useSidebarCollapsed();
    return (
      <button type="button" onClick={() => setCollapsed(!collapsed)}>
        {collapsed ? 'collapsed' : 'expanded'}
      </button>
    );
  }

  const first = render(<Probe />);
  expect(window.localStorage.getItem('dispatch:sidebar-collapsed')).toBe('0');
  fireEvent.click(screen.getByRole('button'));
  expect(window.localStorage.getItem('dispatch:sidebar-collapsed')).toBe('1');
  first.unmount();

  render(<Probe />);
  expect(screen.getByRole('button').textContent).toBe('collapsed');
});

test('project rows are disabled until a project resolves; fleet rows are not', () => {
  mount(true, { hasActiveProject: false });
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: /^Overview/ })
      .disabled
  ).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'New task' }).disabled
  ).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Sessions' }).disabled
  ).toBe(false);
});
