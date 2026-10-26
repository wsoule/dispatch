import type { TimelineView } from '@dispatch/planning';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { NavAction } from '../../lib/appNav';
import type { PaletteEntry } from '../../lib/paletteEntries';
import { CommandPalette } from './CommandPalette';
import type { ShellActions } from './ShellActionsContext';
import { ShellActionsProvider } from './ShellActionsContext';

function shellActions(overrides: Partial<ShellActions> = {}): ShellActions {
  return {
    openTask: () => {},
    openThread: () => {},
    peekTask: () => {},
    openCreateTask: () => {},
    createPreset: null,
    closeCreateTask: () => {},
    openPalette: () => {},
    openOverseer: () => {},
    setProjectView: () => {},
    setGlobalView: () => {},
    openShortcuts: () => {},
    copyTaskId: () => {},
    ...overrides,
  };
}

function entries(ran: string[] = []): PaletteEntry[] {
  const run = (id: string) => () => ran.push(id);
  return [
    {
      id: 'action-new-task',
      label: 'New task',
      kind: 'action',
      section: 'actions',
      shortcut: 'C',
      run: run('action-new-task'),
    },
    {
      id: 'go-board',
      label: 'Go to Board',
      kind: 'go to',
      section: 'navigation',
      shortcut: '⌘1',
      href: '#/issues',
      run: run('go-board'),
    },
    {
      id: 'go-settings',
      label: 'Go to Settings',
      kind: 'go to',
      section: 'navigation',
      shortcut: 'G S',
      href: '#/settings',
      run: run('go-settings'),
    },
    {
      id: 'task-t-716d89',
      label: 'Rework the kanban columns',
      sublabel: 't-716d89',
      kind: 'task',
      section: 'tasks',
      run: run('task-t-716d89'),
    },
    {
      id: 'dispatch-t-716d89',
      label: 'Dispatch Rework the kanban columns',
      sublabel: 't-716d89',
      kind: 'action',
      section: 'tasks',
      run: run('dispatch-t-716d89'),
    },
  ];
}

/** Two lanes: Atlas (active, lead Chloe, one milestone due in a week) and
 * Beacon (paused, no lead, one overdue milestone). */
const TIMELINE: TimelineView = {
  today: '2026-10-21',
  windowStart: '2026-10-07',
  windowEnd: '2026-12-30',
  groups: [
    {
      initiativeId: null,
      name: 'No initiative',
      lanes: [
        {
          projectId: 'proj-atlas',
          name: 'Atlas migration',
          url: '',
          leadId: 'user-chloe',
          leadName: 'Chloe Diaz',
          priority: 1,
          statusType: 'started',
          active: true,
          bars: [
            {
              milestoneId: 'ms-dual',
              name: 'Dual-write',
              projectId: 'proj-atlas',
              start: '2026-10-01',
              end: '2026-10-28',
              status: 'on_track',
              reasons: [],
              rubric: { valid: true, gaps: [] },
              doneMeans: { text: 'Both stores agree', source: 'planner' },
              progress: {
                total: 4,
                completed: 1,
                canceled: 0,
                scope: 4,
                open: 3,
                openUnassigned: 0,
                openTriage: 0,
              },
              isNext: true,
              daysLeft: 7,
              weight: null,
            },
          ],
          undated: [],
          unplannedIssueIds: [],
          allocation: null,
        },
        {
          projectId: 'proj-beacon',
          name: 'Beacon search',
          url: '',
          leadId: null,
          leadName: null,
          priority: 2,
          statusType: 'paused',
          active: false,
          bars: [
            {
              milestoneId: 'ms-index',
              name: 'Index rebuild',
              projectId: 'proj-beacon',
              start: '2026-09-01',
              end: '2026-10-18',
              status: 'overdue',
              reasons: [],
              rubric: { valid: true, gaps: [] },
              doneMeans: { text: 'Search answers', source: 'planner' },
              progress: {
                total: 2,
                completed: 0,
                canceled: 0,
                scope: 2,
                open: 2,
                openUnassigned: 0,
                openTriage: 0,
              },
              isNext: true,
              daysLeft: -3,
              weight: null,
            },
          ],
          undated: [],
          unplannedIssueIds: [],
          allocation: null,
        },
      ],
    },
  ],
  banners: {
    projectsWithoutLead: [],
    milestonesWithoutDate: [],
    issuesWithoutMilestone: { count: 0, byProject: [] },
    blockedProjects: [],
  },
};

interface MountOptions {
  actions?: ShellActions;
  ran?: string[];
  /** More entries after the fixed five. */
  extraEntries?: PaletteEntry[];
  dispatched?: NavAction[];
  /** Replaces the default `dispatched.push`. */
  onNavigate?: (action: NavAction) => void;
  timeline?: TimelineView | null;
  searchDocs?: (query: string) => Promise<PaletteEntry[]>;
  isOpen?: boolean;
}

function element({
  actions = shellActions(),
  ran = [],
  extraEntries = [],
  dispatched = [],
  onNavigate = (action) => dispatched.push(action),
  timeline = null,
  searchDocs,
  isOpen = true,
}: MountOptions) {
  return (
    <ShellActionsProvider value={actions}>
      <CommandPalette
        isOpen={isOpen}
        entries={[...entries(ran), ...extraEntries]}
        timeline={timeline}
        onNavigate={onNavigate}
        searchDocs={searchDocs}
      />
    </ShellActionsProvider>
  );
}

function mount(options: MountOptions = {}) {
  return render(element(options));
}

function input() {
  return screen.getByRole<HTMLInputElement>('combobox');
}

/** The section headings, in order (each group is labelled by its heading span). */
function headings(): string[] {
  return screen.queryAllByRole('group').map((group) => {
    const labelledBy = group.getAttribute('aria-labelledby') ?? '';
    return document.getElementById(labelledBy)?.textContent ?? '';
  });
}

function optionTexts(): string[] {
  return screen.getAllByRole('option').map((o) => o.textContent ?? '');
}

function selectedText(): string | null {
  return (
    screen
      .getAllByRole('option')
      .find((o) => o.getAttribute('aria-selected') === 'true')?.textContent ??
    null
  );
}

test('mounts nothing while closed, and the Gr8r dialog with the sections in order while open', () => {
  const view = mount({ isOpen: false });
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(element({ isOpen: true }));
  const dialog = screen.getByRole('dialog', { name: 'Command palette' });
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(document.activeElement).toBe(input());
  expect(input().placeholder).toBe('Type a command or search…');
  expect(headings()).toEqual(['Tasks', 'Navigation', 'Actions']);
  expect(screen.getAllByRole('option')).toHaveLength(5);
  // The first row belongs to the first section, so the initial selection is a task.
  expect(selectedText()).toContain('Rework the kanban columns');
});

test('rows carry an icon or mark, the task id as a hint, and keycaps with the platform modifier', () => {
  mount();
  for (const row of screen.getAllByRole('option')) {
    expect(row.querySelector('svg')).not.toBeNull();
    expect(row.textContent).not.toContain('go to');
  }
  const taskRow = screen
    .getAllByRole('option')
    .find((row) => row.textContent?.includes('Rework the kanban columns'));
  expect(taskRow?.textContent).toContain('t-716d89');
  const caps = screen
    .getAllByRole('option')
    .flatMap((row) => Array.from(row.querySelectorAll('kbd kbd')))
    .map((kbd) => kbd.textContent);
  // happy-dom is not a Mac: the modifier prints as Ctrl, never a hard-coded ⌘.
  expect(caps).toEqual(['Ctrl', '1', 'G', 'S', 'C']);
  expect(document.body.textContent).not.toContain('⌘');
});

test('a task id fuzzy-matches through the hint and narrows the rows to its section', () => {
  mount();
  fireEvent.change(input(), { target: { value: 't-716d89' } });
  expect(headings()).toEqual(['Tasks']);
  expect(optionTexts()).toHaveLength(2);
  expect(optionTexts()[0]).toContain('Rework the kanban columns');
  fireEvent.change(input(), { target: { value: 'go to sett' } });
  expect(headings()).toEqual(['Navigation']);
  expect(selectedText()).toContain('Go to Settings');
});

test('Enter closes the menu first, then runs the active row', () => {
  // One log for both, so the order of closing and running is visible.
  const log: string[] = [];
  mount({ ran: log, onNavigate: (action) => log.push(action.type) });
  fireEvent.change(input(), { target: { value: 'new task' } });
  fireEvent.keyDown(input(), { key: 'Enter' });
  expect(log).toEqual(['closePalette', 'action-new-task']);
});

test('Esc and the scrim close through the reducer, nothing else runs', () => {
  const ran: string[] = [];
  const dispatched: NavAction[] = [];
  mount({ ran, dispatched });
  fireEvent.keyDown(input(), { key: 'Escape' });
  expect(dispatched).toEqual([{ type: 'closePalette' }]);
  expect(ran).toEqual([]);
});

test('Tab with a query hands it to the Overseer and closes; an empty query walks the sections', () => {
  const prompts: string[] = [];
  const dispatched: NavAction[] = [];
  mount({
    actions: shellActions({ openOverseer: (p) => prompts.push(p ?? '') }),
    dispatched,
  });
  expect(screen.queryByRole('button', { name: /Ask your agent/ })).toBeNull();
  fireEvent.keyDown(input(), { key: 'Tab' });
  expect(prompts).toEqual([]);
  expect(dispatched).toEqual([]);
  expect(selectedText()).toContain('Go to Board');

  fireEvent.change(input(), { target: { value: 'why is the build red ' } });
  expect(
    screen.getByRole('button', { name: /Tab.*Ask your agent/ })
  ).toBeDefined();
  fireEvent.keyDown(input(), { key: 'Tab', shiftKey: true });
  expect(prompts).toEqual([]);

  fireEvent.keyDown(input(), { key: 'Tab' });
  expect(prompts).toEqual(['why is the build red']);
  expect(dispatched).toEqual([{ type: 'closePalette' }]);
});

test('the footer "?" opens the shortcuts sheet without closing the menu', () => {
  const dispatched: NavAction[] = [];
  mount({ dispatched });
  fireEvent.click(screen.getByRole('button', { name: /Shortcuts/ }));
  expect(dispatched).toEqual([{ type: 'openShortcuts' }]);
});

test('a row that was run leads its section on the next open', () => {
  const ran: string[] = [];
  const dispatched: NavAction[] = [];
  const view = mount({ ran, dispatched });
  const row = screen
    .getAllByRole('option')
    .find((r) => r.textContent?.includes('Go to Settings'));
  if (row === undefined) throw new Error('Go to Settings row not rendered');
  fireEvent.click(row);
  expect(ran).toEqual(['go-settings']);
  expect(dispatched).toEqual([{ type: 'closePalette' }]);

  // The host stays mounted while the reducer closes and reopens the menu.
  view.rerender(element({ ran, dispatched, isOpen: false }));
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(element({ ran, dispatched, isOpen: true }));
  expect(input().value).toBe('');
  const navigation = screen.getByRole('group', { name: 'Navigation' });
  const navRows = Array.from(
    navigation.querySelectorAll('[role="option"]')
  ).map((r) => r.textContent);
  expect(navRows[0]).toContain('Go to Settings');
  expect(navRows[1]).toContain('Go to Board');
});

test('Jump to rows list the projects and milestones with status marks; a milestone opens its page', () => {
  const dispatched: NavAction[] = [];
  mount({ dispatched, timeline: TIMELINE });
  expect(headings()).toEqual(['Tasks', 'Jump to', 'Navigation', 'Actions']);
  const jump = screen.getByRole('group', { name: 'Jump to' });
  const rows = Array.from(jump.querySelectorAll('[role="option"]')).map(
    (r) => r.textContent
  );
  expect(rows).toEqual([
    'Atlas migrationProject · Chloe Diaz',
    'Beacon searchProject · No lead',
    'Dual-writeAtlas migration · due Oct 28',
    'Index rebuildBeacon search · due Oct 18',
  ]);
  expect(screen.getAllByRole('img', { name: 'On track' })).toHaveLength(2);
  const muted = screen.getAllByRole('img', {
    name: 'Overdue · inactive project',
  });
  expect(muted).toHaveLength(2);
  for (const mark of muted) expect(mark.hasAttribute('data-muted')).toBe(true);

  fireEvent.change(input(), { target: { value: 'dual' } });
  expect(selectedText()).toContain('Dual-write');
  fireEvent.keyDown(input(), { key: 'Enter' });
  expect(dispatched).toEqual([
    { type: 'closePalette' },
    { type: 'openTask', taskId: 'ms-dual' },
  ]);
});

test('a query also searches docs after a pause, listing the hits under Docs as the daemon ranked them', async () => {
  const asked: string[] = [];
  const ran: string[] = [];
  mount({
    ran,
    searchDocs: (query) => {
      asked.push(query);
      return Promise.resolve([
        {
          id: 'doc:doc-1#columns',
          label: 'Board spec › Columns',
          sublabel: 'board',
          kind: 'doc',
          section: 'docs',
          href: '#/docs/doc-1?anchor=columns',
          run: () => ran.push('doc-1#columns'),
        },
      ]);
    },
  });
  expect(headings()).toEqual(['Tasks', 'Navigation', 'Actions']);
  fireEvent.change(input(), { target: { value: 'kanban' } });
  expect(headings()).toEqual(['Tasks']);
  await waitFor(() => expect(headings()).toEqual(['Tasks', 'Docs']));
  expect(asked).toEqual(['kanban']);
  // The hit does not fuzzy-match "kanban": the host matched it, so it is
  // listed as given and not highlighted.
  const row = screen
    .getAllByRole('option')
    .find((r) => r.textContent?.includes('Board spec › Columns'));
  if (row === undefined) throw new Error('doc row not rendered');
  expect(row.querySelector('mark')).toBeNull();
  fireEvent.click(row);
  expect(ran).toEqual(['doc-1#columns']);
});

test('doc rows for an earlier query vanish as soon as the query changes', async () => {
  const ran: string[] = [];
  mount({
    ran,
    searchDocs: (query) =>
      Promise.resolve([
        {
          id: `doc:doc-1#${query}`,
          label: `Board spec › ${query}`,
          kind: 'doc',
          section: 'docs',
          run: () => ran.push(query),
        },
      ]),
  });
  fireEvent.change(input(), { target: { value: 'kanban' } });
  await screen.findByText('Board spec › kanban');
  fireEvent.change(input(), { target: { value: 'swimlane' } });
  expect(screen.queryByText('Board spec › kanban')).toBeNull();
  expect(screen.queryAllByRole('option')).toHaveLength(0);
  fireEvent.keyDown(input(), { key: 'Enter' });
  expect(ran).toEqual([]);
  expect(await screen.findByText('Board spec › swimlane')).toBeDefined();
});

test('without a docs searcher, a query only filters the local rows', async () => {
  mount();
  fireEvent.change(input(), { target: { value: 'kanban' } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(headings()).toEqual(['Tasks']);
});

/** `count` task entries after the fixed ones, ids task-t-0…, labels "Task 0…". */
function manyTasks(count: number): PaletteEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `task-t-${i}`,
    label: `Task ${i}`,
    sublabel: `t-${i}`,
    kind: 'task' as const,
    section: 'tasks' as const,
    run: () => undefined,
  }));
}

test('with the query empty each section keeps its cap, so Navigation and Actions stay in reach under a long task list', () => {
  mount({ extraEntries: manyTasks(20), timeline: TIMELINE });
  expect(headings()).toEqual(['Tasks', 'Jump to', 'Navigation', 'Actions']);
  const tasks = screen.getByRole('group', { name: 'Tasks' });
  expect(tasks.querySelectorAll('[role="option"]')).toHaveLength(8);
  // Two fixed task rows and twenty more: 22 in all, 8 shown.
  expect(tasks.textContent).toContain('+14 more · keep typing');
  const navigation = screen.getByRole('group', { name: 'Navigation' });
  expect(navigation.querySelectorAll('[role="option"]')).toHaveLength(2);
  expect(navigation.textContent).not.toContain('keep typing');
  // Typing narrows Tasks past its cap again: the rows the query matches.
  fireEvent.change(input(), { target: { value: 'Task 1' } });
  const narrowed = screen.getByRole('group', { name: 'Tasks' });
  expect(
    narrowed.querySelectorAll('[role="option"]').length
  ).toBeLessThanOrEqual(8);
});

test('a Jump to row that was run leads Jump to on the next open, and a project row opens its Timeline lane', () => {
  const dispatched: NavAction[] = [];
  const view = mount({ dispatched, timeline: TIMELINE });
  const jumpRows = () =>
    Array.from(
      screen
        .getByRole('group', { name: 'Jump to' })
        .querySelectorAll('[role="option"]')
    ).map((r) => r.textContent);
  expect(jumpRows()[0]).toContain('Atlas migration');
  const beacon = screen
    .getAllByRole('option')
    .find((r) => r.textContent?.includes('Beacon search'));
  if (beacon === undefined) throw new Error('Beacon row not rendered');
  fireEvent.click(beacon);
  expect(dispatched).toEqual([
    { type: 'closePalette' },
    { type: 'openTimeline', project: 'proj-beacon' },
  ]);

  view.rerender(element({ dispatched, timeline: TIMELINE, isOpen: false }));
  view.rerender(element({ dispatched, timeline: TIMELINE, isOpen: true }));
  expect(jumpRows()[0]).toContain('Beacon search');
  expect(jumpRows()[1]).toContain('Atlas migration');
});

test('text that matches nothing says so and what to try, Tab to the agent included', () => {
  mount();
  fireEvent.change(input(), { target: { value: 'zzzz' } });
  expect(screen.queryAllByRole('option')).toHaveLength(0);
  expect(screen.getByText('No matches for “zzzz”')).toBeDefined();
  expect(
    screen.getByText(
      'Try another task id or title, or press Tab to ask your agent.'
    )
  ).toBeDefined();
});
