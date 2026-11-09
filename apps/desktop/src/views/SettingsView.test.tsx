import type { ApiClient, BoardSyncStatus, SyncStatus } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, mock, test } from 'bun:test';
import { Bot, Coins } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { SessionDetailModal } from '../components/sessions/SessionDetailModal';
import {
  ATTACHED_BACKGROUND_READ_ONLY,
  ATTACHED_READ_ONLY,
  NEEDS_DECIDE,
} from '../components/settings/access';
import {
  dataWith,
  selectTrigger,
  testConfig,
  testProject,
  visibleText,
} from '../components/settings/fixtures.test-helper';
import { OPERATOR_ONLY } from '../components/settings/SettingsGroup';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { SPLIT_MIN_WIDTH } from '../hooks/useFittedDiffLayout';
import { useGlobalKeyboard } from '../hooks/useGlobalKeyboard';
import type { SettingsPage } from '../lib/appNav';
import type { GlobalKeyCommand } from '../lib/keyboard';

// The Diffs tab's preview renders through `PierreWorkerPool`, which imports
// `@pierre/diffs/worker/worker.js?worker&url` — a Vite-only specifier `bun test`
// cannot resolve. Stubbed to a passthrough, the way DiffSurface.test.tsx does,
// and the view imported afterwards so the stub is what it sees.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
}));
const { SettingsView } = await import('./SettingsView');

const project = testProject;
const data = dataWith();

// The settings rail: a link per page inside the `Settings` navigation landmark.
function navRows() {
  return within(
    screen.getByRole('navigation', { name: 'Settings' })
  ).getAllByRole('link');
}

function navLink(name: string): HTMLElement {
  return within(screen.getByRole('navigation', { name: 'Settings' })).getByRole(
    'link',
    { name }
  );
}

function selectPage(name: string) {
  fireEvent.click(navLink(name));
}

test('with no project selected it explains what to do', () => {
  render(<SettingsView activeProject={null} data={data} />);
  expect(screen.getByText(/Pick a project/)).toBeDefined();
});

test('it opens on General and switches to Linear', () => {
  render(<SettingsView activeProject={project} data={data} />);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('General');
  expect(navLink('General').getAttribute('aria-current')).toBe('page');
  selectPage('Linear');
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Linear');
  expect(screen.getByRole('heading', { name: 'Connection' })).toBeDefined();
});

// Pages that read through react-query (Board sync's status line) need the
// provider the app mounts at its root in main.tsx.
// One client per call, so a rerender keeps the same cache.
function withQueryClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

// `initialPage` is how the rail's Connect Linear and the strip's gear land on
// the Linear page, whose id stays `integrations`.
test('initialPage opens on that page, and a new value while mounted switches to it', () => {
  const { rerender } = render(
    <SettingsView
      activeProject={project}
      data={data}
      initialPage="integrations"
    />,
    { wrapper: withQueryClient() }
  );
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Linear');
  expect(navLink('Linear').getAttribute('aria-current')).toBe('page');
  rerender(
    <SettingsView activeProject={project} data={data} initialPage="daemon" />
  );
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
    'Background'
  );
});

// The rail groups pages by what you are doing, under three headings, and the
// selected page's title is the column's H1 with a one-line intro under it.
test('the rail groups every page, and the page title is the H1', () => {
  const ledgerData = dataWith({
    client: { fetchLedger: () => Promise.resolve([]) } as unknown as ApiClient,
  });
  render(<SettingsView activeProject={project} data={ledgerData} />);
  for (const heading of ['Project', 'Team', 'Connections', 'This machine']) {
    expect(screen.getByText(heading)).toBeDefined();
  }
  expect(navRows().map((row) => row.textContent)).toEqual([
    'Setup',
    'General',
    'Agents',
    'Checks',
    'Autonomy',
    'Memory',
    'Previews',
    'Planning',
    'Notifications',
    'Members',
    'Board sync',
    'License',
    'Linear',
    'Connected agents',
    'A2A',
    'Remotes',
    'Web access',
    'Devices',
    'Background',
    'Diff display',
  ]);
  expect(
    screen.getByText(/The theme in this browser, the board's columns/)
  ).toBeDefined();
  selectPage('Autonomy');
  expect(screen.getByRole('slider', { name: 'Autonomy' })).toBeDefined();
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
    'Autonomy'
  );
  selectPage('Notifications');
  expect(screen.getByLabelText('Webhook URL')).toBeDefined();
});

// Memory's page reads the store's health on its own, beside its run settings.
test('the Memory page shows the store and the run settings', async () => {
  const memoryData = dataWith({
    port: 4321,
    client: {
      memoryHealth: () =>
        Promise.resolve({
          available: true,
          reason: null,
          search: 'fts5',
          entries: 3,
          openProposals: 0,
          ledgerImport: null,
          configWarnings: [],
          lastDecayAt: null,
          personal: null,
          pinnedOverflow: false,
          claudeImport: null,
        }),
      memoryIdentity: () =>
        Promise.resolve({
          identity: 'self',
          aliases: [],
          placeholderEmail: false,
        }),
      listIngestProblems: () => Promise.resolve({ problems: [] }),
    } as unknown as ApiClient,
  });
  render(
    <SettingsView
      activeProject={project}
      data={memoryData}
      initialPage="memory"
    />,
    { wrapper: withQueryClient() }
  );
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Memory');
  expect(
    await screen.findByText('3 entries · no open proposals · full-text search')
  ).toBeDefined();
  expect(screen.getByLabelText('Index budget')).toBeDefined();
});

// Each page is a stack of section headings over grouped cards.
test('a page renders its sections as level-2 headings', () => {
  render(<SettingsView activeProject={project} data={data} />);
  expect(
    screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
  ).toEqual(['Appearance', 'Board columns', 'Pull requests']);
});

// The theme is a per-computer preference, not config, so General shows it
// before the config has loaded, and Settings search finds it.
test('General shows Appearance and the Theme control even with no config yet', () => {
  render(
    <SettingsView activeProject={project} data={dataWith({ config: null })} />
  );
  expect(
    screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
  ).toEqual(['Appearance']);
  const theme = screen.getByRole('radiogroup', { name: 'Theme' });
  expect(
    within(theme)
      .getAllByRole('radio')
      .map((el) => el.textContent)
  ).toEqual(['System', 'Light', 'Dark']);
});

// Search renders every page, so the client needs what the Autonomy page reads.
const searchData = dataWith({
  client: { fetchLedger: () => Promise.resolve([]) } as unknown as ApiClient,
});

// Lets the reads a page starts on mount land inside act: the Autonomy page's
// receipts (PolicySection's `fetchLedger`) resolve a tick after it renders, on
// its page or in search results (which render every page), and a test that
// ends before then sees React warn about an update outside act. Search also
// mounts the license and team groups, whose react-query reads settle over a
// few timer turns (the query, then its batched notify; two suffice today), so
// this waits several.
const SETTLE_TURNS = 5;
async function settleReads() {
  await act(async () => {
    for (let turn = 0; turn < SETTLE_TURNS; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function search(value: string) {
  fireEvent.change(screen.getByLabelText('Search settings'), {
    target: { value },
  });
}

test('Settings search for dark finds the Theme control', async () => {
  render(<SettingsView activeProject={project} data={searchData} />, {
    wrapper: withQueryClient(),
  });
  search('dark');
  await settleReads();
  // Diff display's own group is "Diff appearance", so the two never share a
  // heading; the Theme control is the one under General.
  const theme = screen.getByRole('radiogroup', { name: 'Theme' });
  expect(within(theme).getByRole('radio', { name: 'Dark' })).toBeDefined();
  expect(screen.queryByText('No settings match')).toBeNull();
});

// Search swaps the page for the matching settings from every page, grouped
// under the page they live on, and each is still the real, editable control.
test('search shows matching settings from every page, editable in place', async () => {
  const ledgerData = dataWith({
    client: { fetchLedger: () => Promise.resolve([]) } as unknown as ApiClient,
  });
  render(<SettingsView activeProject={project} data={ledgerData} />, {
    wrapper: withQueryClient(),
  });
  search('budget');
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
    'Results for “budget”'
  );
  // The spend limit matches on a keyword, the hard stop on its own words.
  expect(screen.getByLabelText('Spend per run')).toBeDefined();
  expect(screen.getByText('Spending past the per-run limit')).toBeDefined();
  // Rows that don't match are gone, even in a group that has a match.
  expect(screen.queryByText('Runs at once')).toBeNull();
  // Editing a result saves like it does on its page.
  const spend = screen.getByLabelText('Spend per run');
  fireEvent.change(spend, { target: { value: '7' } });
  fireEvent.blur(spend);
  expect(await screen.findByText('Saved')).toBeDefined();
});

// A page or group that matches by name shows everything in it.
test('a search that names a group shows the whole group', async () => {
  render(<SettingsView activeProject={project} data={searchData} />, {
    wrapper: withQueryClient(),
  });
  search('limits');
  await settleReads();
  for (const label of [
    'Runs at once',
    'Runs at once per milestone',
    'Turns per run',
    'Spend per run',
    'Expected cost per run',
  ]) {
    expect(screen.getByLabelText(label)).toBeDefined();
  }
});

test('a search with no match says so, and clearing it returns to the page', () => {
  render(<SettingsView activeProject={project} data={searchData} />, {
    wrapper: withQueryClient(),
  });
  search('zebra');
  expect(screen.getByText('No settings match')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('General');
});

test('picking a page from the rail ends the search', () => {
  render(<SettingsView activeProject={project} data={searchData} />, {
    wrapper: withQueryClient(),
  });
  search('webhook');
  selectPage('Agents');
  expect(screen.getByLabelText<HTMLInputElement>('Search settings').value).toBe(
    ''
  );
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Agents');
});

// AgentsSection has no saving/saved state of its own, so this passes only
// because the shell's shared indicator rendered the text.
test('a save reports through the shared indicator', async () => {
  render(<SettingsView activeProject={project} data={data} />);
  selectPage('Agents');
  fireEvent.click(screen.getByLabelText('Ask me every time'));
  expect(await screen.findByText('Saved')).toBeDefined();
});

// Diff display is a browser preference with no config write behind it, so
// the indicator has nothing to say there.
test('the Diff display page shows no save state', async () => {
  render(<SettingsView activeProject={project} data={data} />);
  selectPage('Agents');
  fireEvent.click(screen.getByLabelText('Ask me every time'));
  expect(await screen.findByText('Saved')).toBeDefined();
  selectPage('Diff display');
  expect(screen.queryByText('Saved')).toBeNull();
});

// Owner-only settings show read-only behind a lock below that tier, and are
// editable at it.
test('owner-only settings lock below the operator tier', () => {
  const { unmount } = render(
    <SettingsView activeProject={project} data={data} />
  );
  selectPage('Checks');
  expect(
    screen.getByLabelText<HTMLInputElement>('Single check command').disabled
  ).toBe(true);
  unmount();
  render(
    <SettingsView
      activeProject={project}
      data={dataWith({ myTier: 'operator' })}
    />
  );
  selectPage('Checks');
  expect(
    screen.getByLabelText<HTMLInputElement>('Single check command').disabled
  ).toBe(false);
});

// LinearPanel never had a local "Saved" text of its own, so this only passes
// if the shell's shared save is actually wired in.
test('a Linear config save reports through the shared indicator too', async () => {
  const connectedData = dataWith({ connected: true });
  render(<SettingsView activeProject={project} data={connectedData} />);
  selectPage('Linear');
  const interval = screen.getByLabelText('Check for changes every');
  fireEvent.change(interval, { target: { value: '120' } });
  fireEvent.blur(interval);
  expect(await screen.findByText('Saved')).toBeDefined();
});

// Sharing needs a database-backed board, and committing task files only does
// anything on a board kept as files, so the page offers whichever applies.
test('Board sync offers sharing on a database board and committing on a file board', () => {
  const { unmount } = render(
    <SettingsView activeProject={project} data={data} initialPage="sync" />,
    { wrapper: withQueryClient() }
  );
  expect(
    screen.getByRole('switch', { name: 'Share this board with teammates' })
  ).toBeDefined();
  expect(
    screen.queryByRole('switch', { name: /Commit task files/ })
  ).toBeNull();
  unmount();

  const health = { pr: false, storageBackend: 'files' as const };
  render(
    <SettingsView
      activeProject={project}
      data={dataWith({ health })}
      initialPage="sync"
    />,
    { wrapper: withQueryClient() }
  );
  expect(
    screen.getByRole('switch', { name: 'Commit task files to the main branch' })
  ).toBeDefined();
  expect(
    screen.queryByRole('switch', { name: 'Share this board with teammates' })
  ).toBeNull();
  expect(screen.getByText("Sharing isn't available")).toBeDefined();
});

// Whether a control can't be used: disabled itself, or a native control inside
// a locked group (happy-dom doesn't carry a disabled fieldset down).
function isDisabled(element: HTMLElement): boolean {
  if ((element as HTMLInputElement).disabled === true) return true;
  return (
    element.matches('button, input, select, textarea') &&
    element.closest('fieldset')?.disabled === true
  );
}

// The lock beside a level-2 group heading, as its reason; null when unlocked.
function headingLock(name: string): string | null {
  const heading = screen.getByRole('heading', { level: 2, name });
  return (
    heading.parentElement
      ?.querySelector('[aria-label]')
      ?.getAttribute('aria-label') ?? null
  );
}

// The lock beside a row's title, as its reason; null when unlocked.
function rowLock(title: string): string | null {
  return (
    screen
      .getByText(title)
      .parentElement?.querySelector('[aria-label]')
      ?.getAttribute('aria-label') ?? null
  );
}

type ConfigSave = Parameters<DispatchProjectData['handleUpdateConfig']>[0];

// The save line beside the page title.
function saveLine(): HTMLElement {
  const titleRow = screen.getByRole('heading', { level: 1 }).parentElement;
  if (titleRow === null) throw new Error('no page title row');
  return within(titleRow).getByRole('status');
}

// The group a level-2 heading names, for controls without a label of their own.
function group(name: string): HTMLElement {
  const section = screen
    .getByRole('heading', { level: 2, name })
    .closest('section');
  if (section === null) throw new Error(`no group named ${name}`);
  return section;
}

const sharingOn: BoardSyncStatus = {
  enabled: true,
  replica: 'ada-1a2b3c4d',
  remote: 'origin',
  branch: 'dispatch-sync',
  lastSyncAt: null,
  lastError: null,
  pending: 0,
  applied: 0,
  problems: [],
  people: 2,
  seats: 3,
  paused: null,
};

// Everything the pages read, at `myTier`: a Linear connection on the
// project's own key with a team chosen, a ledger, a board sync status, and
// the team lists search renders along with every other page.
function tierData(
  overrides: Partial<DispatchProjectData> & {
    sync?: BoardSyncStatus;
  } = {}
): DispatchProjectData {
  const { sync = { enabled: false }, ...rest } = overrides;
  const connected = dataWith({ connected: true, keySource: 'project' });
  return dataWith({
    connected: true,
    keySource: 'project',
    config: {
      ...testConfig,
      linear: { ...testConfig.linear, teamId: 'team-1', teamIds: ['team-1'] },
    },
    linearStatus: {
      ...connected.linearStatus,
      teamId: 'team-1',
    } as DispatchProjectData['linearStatus'],
    client: {
      baseUrl: 'http://127.0.0.1:1',
      fetchLedger: () => Promise.resolve([]),
      fetchBoardSyncStatus: () => Promise.resolve(sync),
      syncBoardNow: () => Promise.resolve(sync),
      fetchTeamTokens: () => Promise.resolve([]),
      fetchTeamAddress: () => Promise.resolve({ origins: [] }),
      listAgentRoster: () =>
        Promise.resolve({
          agents: [
            {
              address: 'agent:wyat/cursor.macbook',
              displayName: 'cursor.macbook',
              client: 'cursor',
              status: 'pending',
              muted: false,
              approvedBy: null,
              createdAt: '2026-09-20T10:00:00.000Z',
            },
          ],
        }),
    } as unknown as ApiClient,
    presence: [],
    ...rest,
  });
}

function renderAt(data: DispatchProjectData, page: SettingsPage) {
  return render(
    <SettingsView activeProject={project} data={data} initialPage={page} />,
    { wrapper: withQueryClient() }
  );
}

interface PageLocks {
  page: SettingsPage;
  /** Groups that save config, so must show the lock below decide. */
  locked: string[];
  /** Groups whose controls hit routes of their own, or none at all. */
  open?: string[];
  /** A sample of each locked group's controls. */
  controls: () => HTMLElement[];
}

const CONFIG_PAGES: PageLocks[] = [
  {
    page: 'general',
    locked: ['Board columns', 'Pull requests'],
    controls: () => [
      screen.getByLabelText('Add a column'),
      screen.getByRole('button', { name: 'Move backlog down' }),
      screen.getByRole('button', { name: 'Remove todo' }),
    ],
  },
  {
    page: 'agents',
    locked: [
      'Models',
      'Streaming',
      'Limits',
      'Permissions',
      'Defaults',
      'Command-line agents',
    ],
    controls: () => [
      selectTrigger('Coding runs model'),
      ...within(group('Streaming')).getAllByRole('radio'),
      screen.getByLabelText('Runs at once'),
      screen.getByLabelText('Spend per run'),
      screen.getByLabelText('Ask me every time'),
      selectTrigger('Default agent'),
    ],
  },
  {
    page: 'checks',
    locked: ['Before merging', 'Trying the change', 'Fix loop', 'Escalation'],
    controls: () => [
      screen.getByLabelText('Time limit per check'),
      screen.getByLabelText('Address'),
      screen.getByLabelText('Notes for the agent'),
      screen.getByRole('switch', { name: 'Start fixing automatically' }),
      screen.getByLabelText('Rounds before asking you'),
      screen.getByRole('button', { name: 'Add round' }),
    ],
  },
  {
    page: 'autonomy',
    locked: ['Level', 'Overrides', 'Task ranking'],
    open: ['Hard stops', 'Recent automatic decisions'],
    controls: () => [
      screen.getByRole('slider', { name: 'Autonomy' }),
      ...screen.getAllByRole('button', { name: / override: / }),
      ...within(group('Task ranking')).getAllByRole('textbox'),
    ],
  },
  {
    page: 'previews',
    locked: ['Live previews', 'Timing'],
    controls: () => [
      screen.getByRole('switch', { name: 'Allow previews' }),
      screen.getByLabelText('Time to start'),
      screen.getByLabelText('Stop when unused for'),
    ],
  },
  {
    page: 'notifications',
    locked: ['Notify me when', 'Webhook'],
    controls: () => [
      ...within(group('Notify me when')).getAllByRole('switch'),
      screen.getByLabelText('Webhook URL'),
    ],
  },
  {
    page: 'sync',
    locked: ['Sharing'],
    open: ['Status'],
    // The branch is the owner's too, so it shows as text with no control.
    controls: () => [
      screen.getByRole('switch', { name: 'Share this board with teammates' }),
      screen.getByLabelText("Check for teammates' changes every"),
    ],
  },
  {
    page: 'integrations',
    locked: ['Sync settings', 'Teams', 'Status roles'],
    open: ['Connection', 'Sync', 'Coverage', 'Capacity'],
    controls: () => [
      screen.getByRole('switch', { name: 'Sync this project with Linear' }),
      selectTrigger('Direction'),
      screen.getByLabelText('Poll interval'),
      screen.getByRole('switch', {
        name: 'Send Acceptance Criteria to Linear',
      }),
      screen.getByRole('switch', {
        name: 'Archive finished tasks in Linear too',
      }),
      screen.getByRole('checkbox', { name: 'Link Unknown team' }),
      selectTrigger('Run finishes status'),
    ],
  },
  {
    page: 'daemon',
    locked: ['Receipt log', 'Code understanding'],
    open: ['Status'],
    controls: () => [
      screen.getByRole('switch', { name: 'Keep a receipt log' }),
      selectTrigger('Code map'),
      screen.getByRole('switch', { name: 'Repo summary' }),
      screen.getByLabelText('Refresh the summary at most every'),
    ],
  },
];

describe('below the decide tier, config is read-only', () => {
  for (const spec of CONFIG_PAGES) {
    test(`${spec.page}: every config control is locked, with the reason`, async () => {
      renderAt(tierData({ myTier: 'request' }), spec.page);
      await settleReads();
      // Board sync's status line arrives from a query.
      if (spec.page === 'sync') await screen.findByText('Not sharing');
      expect(screen.getByRole('note').textContent).toBe(NEEDS_DECIDE);
      // The note leads with the lock the locked rows carry; the mark is
      // decoration, so the note's text stays exactly the reason.
      expect(
        screen.getByRole('note').querySelector('svg[aria-hidden="true"]')
      ).not.toBeNull();
      for (const name of spec.locked) {
        expect({ name, lock: headingLock(name) }).toEqual({
          name,
          lock: NEEDS_DECIDE,
        });
      }
      for (const name of spec.open ?? []) {
        expect({ name, lock: headingLock(name) }).toEqual({ name, lock: null });
      }
      const controls = spec.controls();
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) {
        expect({
          control: control.getAttribute('aria-label') ?? control.id,
          disabled: isDisabled(control),
        }).toEqual({
          control: control.getAttribute('aria-label') ?? control.id,
          disabled: true,
        });
      }
    });
  }

  // Clicks as well as the disabled check: only a click shows a switch is
  // really locked.
  test('clicking any switch saves nothing', async () => {
    for (const spec of CONFIG_PAGES) {
      const handleUpdateConfig = mock((_patch: ConfigSave) =>
        Promise.resolve()
      );
      const { unmount } = renderAt(
        tierData({ myTier: 'request', handleUpdateConfig }),
        spec.page
      );
      if (spec.page === 'sync') await screen.findByText('Not sharing');
      for (const toggle of screen.queryAllByRole('switch')) {
        fireEvent.click(toggle);
        fireEvent.keyDown(toggle, { key: ' ' });
      }
      expect({
        page: spec.page,
        saves: handleUpdateConfig.mock.calls.length,
      }).toEqual({ page: spec.page, saves: 0 });
      unmount();
    }
  });

  // The theme is saved in this browser, not config, so General draws it above
  // the read-only note: the note then speaks only for the config below it.
  test('General: Appearance sits above the note and stays editable', () => {
    try {
      renderAt(tierData({ myTier: 'request' }), 'general');
      const note = screen.getByRole('note');
      expect(note.textContent).toBe(NEEDS_DECIDE);
      const follows = (a: Node, b: Node) =>
        (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      const appearance = screen.getByRole('heading', {
        level: 2,
        name: 'Appearance',
      });
      const columns = screen.getByRole('heading', {
        level: 2,
        name: 'Board columns',
      });
      expect(follows(appearance, note)).toBe(true);
      expect(follows(note, columns)).toBe(true);
      expect(headingLock('Appearance')).toBeNull();
      const dark = within(
        screen.getByRole('radiogroup', { name: 'Theme' })
      ).getByRole('radio', { name: 'Dark' });
      expect(isDisabled(dark)).toBe(false);
      fireEvent.click(dark);
      expect(localStorage.getItem('dispatch:theme')).toBe('dark');
      expect(headingLock('Board columns')).toBe(NEEDS_DECIDE);
    } finally {
      localStorage.removeItem('dispatch:theme');
      delete document.documentElement.dataset.theme;
      document.documentElement.removeAttribute('data-theme-switching');
    }
  });

  // Can approve access isn't enough for an owner-only row, so its own lock
  // stays; in an attached window, restarting from the app unlocks both.
  test('owner-only rows keep their own lock inside a locked group', () => {
    const { unmount } = renderAt(tierData({ myTier: 'request' }), 'general');
    expect(headingLock('Pull requests')).toBe(NEEDS_DECIDE);
    expect(rowLock('Checkout folder')).toBe(OPERATOR_ONLY);
    unmount();

    renderAt(
      tierData({ myTier: 'request', attachedWithoutAppToken: true }),
      'general'
    );
    expect(headingLock('Pull requests')).toBe(ATTACHED_READ_ONLY);
    expect(rowLock('Checkout folder')).toBeNull();
  });

  // The owner's own window, attached to a daemon it didn't start, is told to
  // restart from the app rather than to ask someone for access.
  test('an attached window says to restart Dispatch instead', () => {
    renderAt(
      tierData({ myTier: 'request', attachedWithoutAppToken: true }),
      'agents'
    );
    expect(screen.getByRole('note').textContent).toBe(ATTACHED_READ_ONLY);
    expect(screen.queryByText(NEEDS_DECIDE)).toBeNull();
    expect(headingLock('Limits')).toBe(ATTACHED_READ_ONLY);
  });

  // The restart that note asks for sits right under it.
  test('an attached window offers the restart under the note', async () => {
    const restart = mock(() => Promise.resolve());
    renderAt(
      tierData({
        myTier: 'request',
        attachedWithoutAppToken: true,
        takeover: { background: false, busy: [], parked: 0, waiting: 0 },
        handleRestartDaemon: restart,
      }),
      'agents'
    );
    fireEvent.click(screen.getByTestId('daemon-takeover'));
    await waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
  });

  test('says when the CLI started the daemon in the background', () => {
    renderAt(
      tierData({
        myTier: 'request',
        attachedWithoutAppToken: true,
        takeover: { background: true, busy: null, parked: 0, waiting: 0 },
      }),
      'agents'
    );
    expect(screen.getByRole('note').textContent).toBe(
      ATTACHED_BACKGROUND_READ_ONLY
    );
    expect(screen.getByTestId('daemon-takeover')).toBeTruthy();
  });

  test('a teammate below decide is offered no restart', () => {
    renderAt(tierData({ myTier: 'request' }), 'agents');
    expect(screen.queryByTestId('daemon-takeover')).toBeNull();
  });

  // No tier means no connection yet, not a refusal: the owner is not told to
  // ask for access while their own Dispatch starts. Nothing is editable yet.
  test('no tier yet (no connection) shows no read-only note', () => {
    renderAt(tierData({ myTier: null }), 'agents');
    expect(screen.queryByRole('note')).toBeNull();
    expect(isDisabled(screen.getByLabelText('Runs at once'))).toBe(true);
  });

  test('a board kept as files locks its commit switch too', () => {
    const handleUpdateConfig = mock((_patch: ConfigSave) => Promise.resolve());
    renderAt(
      tierData({
        myTier: 'request',
        health: { pr: false, storageBackend: 'files' },
        handleUpdateConfig,
      }),
      'sync'
    );
    expect(headingLock('Task files')).toBe(NEEDS_DECIDE);
    const toggle = screen.getByRole('switch', {
      name: 'Commit task files to the main branch',
    });
    expect(isDisabled(toggle)).toBe(true);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByText('Commit task files to the main branch'));
    expect(handleUpdateConfig).not.toHaveBeenCalled();
  });
});

describe('below the decide tier, what has its own route stays usable', () => {
  // The group stays open, but the key decides whose Linear account the board
  // goes to, so the daemon keeps setting it to the owner.
  test('Linear, not connected: the group is open, but the key is the owner’s', () => {
    renderAt(dataWith({ myTier: 'request' }), 'integrations');
    expect(screen.getByRole('note').textContent).toBe(NEEDS_DECIDE);
    expect(headingLock('Connection')).toBeNull();
    expect(rowLock('API key')).toBe(OPERATOR_ONLY);
    expect(isDisabled(screen.getByLabelText('API key'))).toBe(true);
    expect(isDisabled(screen.getByRole('button', { name: 'Connect' }))).toBe(
      true
    );
  });

  test('Linear, connected: Import, Export and Sync now, but not Disconnect or archiving', () => {
    renderAt(tierData({ myTier: 'request' }), 'integrations');
    for (const name of [
      'Import from Linear',
      'Export to Linear…',
      'Sync now',
    ]) {
      expect({
        name,
        disabled: isDisabled(screen.getByRole('button', { name })),
      }).toEqual({ name, disabled: false });
    }
    expect(isDisabled(screen.getByRole('button', { name: 'Disconnect' }))).toBe(
      true
    );
    // Archiving closed issues acts on teammates' records, so it needs decide.
    expect(rowLock('Archive closed issues in Linear')).toBe(NEEDS_DECIDE);
    expect(isDisabled(screen.getByRole('button', { name: 'Archive…' }))).toBe(
      true
    );
  });

  test('Board sync: Sync now, while sharing is on', async () => {
    renderAt(tierData({ myTier: 'request', sync: sharingOn }), 'sync');
    const syncNow = await screen.findByRole('button', { name: /Sync now/ });
    expect(isDisabled(syncNow)).toBe(false);
    expect(headingLock('Status')).toBeNull();
    // The sharing settings below it are still config.
    expect(headingLock('Sharing')).toBe(NEEDS_DECIDE);
  });

  // A browser preference, never sent to the daemon, so nothing to lock.
  test('Diff display: every control, and no read-only note', () => {
    renderAt(dataWith({ myTier: 'request' }), 'diffs');
    expect(screen.queryByRole('note')).toBeNull();
    expect(headingLock('Diff appearance')).toBeNull();
    for (const control of [
      selectTrigger('Diff layout'),
      selectTrigger('Diff change indicators'),
      screen.getByRole('switch', { name: 'Wrap long lines' }),
      screen.getByRole('switch', { name: 'Show line numbers' }),
    ]) {
      expect(isDisabled(control)).toBe(false);
    }
    // A review diff draws unified below useFittedDiffLayout's SPLIT_MIN_WIDTH
    // whatever the layout says, and the Layout row says so with that width.
    expect(
      screen.getByText(
        `Split shows unified in a review while its diff is narrower than ${SPLIT_MIN_WIDTH}px.`
      )
    ).toBeTruthy();
  });
});

// Anyone can read the roster; approving, muting and revoking need decide.
describe('Connected agents', () => {
  const PENDING = 'agent:wyat/cursor.macbook';
  const actions = () =>
    ['Approve', 'Mute', 'Revoke'].map((name) => ({
      name,
      disabled: isDisabled(
        screen.getByRole('button', { name: `${name} ${PENDING}` })
      ),
    }));

  // The reason is written out, since disabled buttons never show their tooltips.
  test('below decide, the roster shows with its actions locked and the reason', async () => {
    renderAt(tierData({ myTier: 'request' }), 'connected-agents');
    expect(await screen.findByText(PENDING)).toBeDefined();
    expect(screen.queryByRole('note')).toBeNull();
    expect(headingLock('Agents')).toBeNull();
    expect(rowLock('Approving, muting and revoking')).toBe(NEEDS_DECIDE);
    expect(visibleText(NEEDS_DECIDE)).toHaveLength(1);
    expect(actions().every((a) => a.disabled)).toBe(true);
  });

  test('at decide, every action is open', async () => {
    renderAt(tierData({ myTier: 'decide' }), 'connected-agents');
    expect(await screen.findByText(PENDING)).toBeDefined();
    expect(headingLock('Agents')).toBeNull();
    expect(actions().some((a) => a.disabled)).toBe(false);
  });
});

describe('at the decide tier', () => {
  test('config is editable and only the owner-only rows lock', () => {
    const { unmount } = renderAt(tierData({ myTier: 'decide' }), 'general');
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.queryAllByLabelText(NEEDS_DECIDE)).toHaveLength(0);
    expect(headingLock('Board columns')).toBeNull();
    expect(isDisabled(screen.getByLabelText('Add a column'))).toBe(false);
    // Read-only text behind a lock, never an input.
    expect(rowLock('Checkout folder')).toBe(OPERATOR_ONLY);
    expect(document.getElementById('pr-worktree-dir')).toBeNull();
    unmount();

    renderAt(tierData({ myTier: 'decide' }), 'checks');
    expect(screen.queryByRole('note')).toBeNull();
    expect(isDisabled(screen.getByLabelText('Time limit per check'))).toBe(
      false
    );
    expect(
      isDisabled(
        screen.getByRole('switch', { name: 'Start fixing automatically' })
      )
    ).toBe(false);
    expect(isDisabled(screen.getByLabelText('Single check command'))).toBe(
      true
    );
    expect(rowLock('Single check command')).toBe(OPERATOR_ONLY);
    expect(isDisabled(screen.getByLabelText('Start command'))).toBe(true);
  });

  // Sharing pushes on the owner's own git credentials, so whether it runs and
  // which branch it lands on are theirs; how often it checks is not.
  test('Board sync: whether and where the board goes is still the owner’s', async () => {
    renderAt(tierData({ myTier: 'decide' }), 'sync');
    await screen.findByText('Not sharing');
    expect(screen.queryByRole('note')).toBeNull();
    expect(
      isDisabled(
        screen.getByRole('switch', { name: 'Share this board with teammates' })
      )
    ).toBe(true);
    expect(rowLock('Share this board with teammates')).toBe(OPERATOR_ONLY);
    expect(screen.queryByRole('textbox', { name: 'Branch' })).toBeNull();
    expect(rowLock('Branch')).toBe(OPERATOR_ONLY);
    expect(isDisabled(selectTrigger('Where the board is kept'))).toBe(true);
    expect(
      isDisabled(screen.getByLabelText("Check for teammates' changes every"))
    ).toBe(false);
  });
});

describe('at the operator tier', () => {
  for (const spec of CONFIG_PAGES) {
    test(`${spec.page}: nothing is locked`, async () => {
      renderAt(tierData({ myTier: 'operator' }), spec.page);
      await settleReads();
      if (spec.page === 'sync') await screen.findByText('Not sharing');
      expect(screen.queryByRole('note')).toBeNull();
      expect(screen.queryAllByLabelText(NEEDS_DECIDE)).toHaveLength(0);
      expect(screen.queryAllByLabelText(OPERATOR_ONLY)).toHaveLength(0);
      for (const name of [...spec.locked, ...(spec.open ?? [])]) {
        expect({ name, lock: headingLock(name) }).toEqual({ name, lock: null });
      }
      for (const control of spec.controls()) {
        expect({
          control: control.getAttribute('aria-label') ?? control.id,
          disabled: isDisabled(control),
        }).toEqual({
          control: control.getAttribute('aria-label') ?? control.id,
          disabled: false,
        });
      }
    });
  }

  test('the owner-only fields are real, enabled inputs', () => {
    const { unmount } = renderAt(tierData({ myTier: 'operator' }), 'general');
    expect(isDisabled(screen.getByLabelText('Checkout folder'))).toBe(false);
    unmount();
    renderAt(tierData({ myTier: 'operator' }), 'checks');
    expect(isDisabled(screen.getByLabelText('Single check command'))).toBe(
      false
    );
    expect(isDisabled(screen.getByLabelText('Start command'))).toBe(false);
  });
});

// The daemon's own refusal is written for the CLI (`--token`, `dispatch team
// invite`), so the save line says what it means here instead.
describe('a refused save', () => {
  const raw = 'this route needs the daemon app token; pass --token';
  const tierRefusal = () =>
    Object.assign(new Error(raw), { code: 'auth_insufficient_tier' });

  function addColumn(name: string) {
    const input = screen.getByLabelText('Add a column');
    fireEvent.change(input, { target: { value: name } });
    const form = input.closest('form');
    if (form === null) throw new Error('no add-a-column form');
    fireEvent.submit(form);
  }

  test('below decide it says who can change settings', async () => {
    renderAt(
      tierData({
        myTier: 'request',
        handleUpdateConfig: () => Promise.reject(tierRefusal()),
      }),
      'general'
    );
    addColumn('qa');
    await waitFor(() => expect(saveLine().textContent).toBe(NEEDS_DECIDE));
    expect(screen.queryByText(raw)).toBeNull();
  });

  test('in an attached window it says to restart instead', async () => {
    renderAt(
      tierData({
        myTier: 'request',
        attachedWithoutAppToken: true,
        handleUpdateConfig: () => Promise.reject(tierRefusal()),
      }),
      'general'
    );
    addColumn('qa');
    await waitFor(() =>
      expect(saveLine().textContent).toBe(ATTACHED_READ_ONLY)
    );
  });

  test('at decide it says the setting is the owner’s', async () => {
    renderAt(
      tierData({
        myTier: 'decide',
        handleUpdateConfig: () => Promise.reject(tierRefusal()),
      }),
      'agents'
    );
    const spend = screen.getByLabelText('Spend per run');
    fireEvent.change(spend, { target: { value: '7' } });
    fireEvent.blur(spend);
    await waitFor(() => expect(saveLine().textContent).toBe(OPERATOR_ONLY));
    expect(screen.queryByText(raw)).toBeNull();
  });

  test('any other failure shows its own message', async () => {
    renderAt(
      tierData({
        myTier: 'operator',
        handleUpdateConfig: () =>
          Promise.reject(new Error('config.yml is not valid YAML')),
      }),
      'agents'
    );
    fireEvent.click(screen.getByLabelText('Ask me every time'));
    await waitFor(() =>
      expect(saveLine().textContent).toBe('config.yml is not valid YAML')
    );
  });

  test('adding a column keeps the typed name until a save succeeds', async () => {
    const handleUpdateConfig = mock((_patch: ConfigSave) => Promise.resolve());
    handleUpdateConfig.mockImplementationOnce(() =>
      Promise.reject(new Error('disk full'))
    );
    renderAt(tierData({ myTier: 'operator', handleUpdateConfig }), 'general');
    addColumn('qa');
    await waitFor(() => expect(saveLine().textContent).toBe('disk full'));
    expect(screen.getByLabelText<HTMLInputElement>('Add a column').value).toBe(
      'qa'
    );
    // Trying again with the kept draft saves it, and only then clears it.
    const form = screen.getByLabelText('Add a column').closest('form');
    if (form === null) throw new Error('no add-a-column form');
    fireEvent.submit(form);
    await waitFor(() => expect(saveLine().textContent).toBe('Saved'));
    expect(screen.getByLabelText<HTMLInputElement>('Add a column').value).toBe(
      ''
    );
    expect(handleUpdateConfig).toHaveBeenCalledTimes(2);
    // New columns go in before the last one, where work ends.
    expect(handleUpdateConfig.mock.calls[1]?.[0]).toHaveProperty('statuses', [
      'backlog',
      'todo',
      'in-progress',
      'in-review',
      'done',
      'qa',
      'cancelled',
    ]);
  });
});

// GET /api/sync as the page reads it: the file committer's state, and the
// receipt log, which is off exactly on a board kept as files.
function syncStatusWith(
  state: SyncStatus['state'],
  receipts: SyncStatus['receipts']['state']
): SyncStatus {
  return {
    state,
    detail: null,
    pushed: 0,
    pulled: 0,
    pendingOutgoing: 0,
    pendingIncoming: 0,
    lastSyncedAt: null,
    mergeDriverWarning: null,
    receipts: {
      state: receipts,
      detail: null,
      commit: null,
      changed: 0,
      removed: 0,
      problems: 0,
      lastExportedAt: null,
    },
  };
}

describe('Board sync by storage backend', () => {
  // Offering the sharing controls on a file board would offer a switch that
  // does nothing, so the page waits for the daemon to say.
  test('until the daemon says how the board is kept, neither is offered', () => {
    renderAt(
      tierData({ myTier: 'operator', health: undefined, syncStatus: null }),
      'sync'
    );
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText("Sharing isn't available")).toBeNull();
  });

  // An older daemon doesn't name its backend; its receipt log being off does.
  test('an older daemon on a file board still gets the commit switch', () => {
    renderAt(
      tierData({
        myTier: 'operator',
        health: { pr: false },
        syncStatus: syncStatusWith('off', 'disabled'),
      }),
      'sync'
    );
    expect(
      screen.getByRole('switch', {
        name: 'Commit task files to the main branch',
      })
    ).toBeDefined();
    expect(
      screen.queryByRole('switch', { name: 'Share this board with teammates' })
    ).toBeNull();
  });

  test('a file board with no main branch says so beside the switch', () => {
    renderAt(
      tierData({
        myTier: 'operator',
        health: { pr: false, storageBackend: 'files' },
        syncStatus: syncStatusWith('disabled', 'disabled'),
      }),
      'sync'
    );
    expect(screen.getByText('No main branch to commit to')).toBeDefined();
  });

  test('a daemon that says sqlite offers sharing, not committing', async () => {
    renderAt(
      tierData({
        myTier: 'operator',
        health: { pr: false, storageBackend: 'sqlite' },
      }),
      'sync'
    );
    await screen.findByText('Not sharing');
    expect(
      screen.getByRole('switch', { name: 'Share this board with teammates' })
    ).toBeDefined();
    expect(
      screen.queryByRole('switch', { name: /Commit task files/ })
    ).toBeNull();
    expect(screen.queryByText("Sharing isn't available")).toBeNull();
  });

  test('search finds the commit switch by its config key on a file board', async () => {
    render(
      <SettingsView
        activeProject={project}
        data={tierData({
          myTier: 'operator',
          health: { pr: false, storageBackend: 'files' },
        })}
      />,
      { wrapper: withQueryClient() }
    );
    search('auto-commit');
    await settleReads();
    const toggle = screen.getByRole('switch', {
      name: 'Commit task files to the main branch',
    });
    expect(isDisabled(toggle)).toBe(false);
    expect(
      screen.queryByRole('switch', { name: 'Share this board with teammates' })
    ).toBeNull();
  });

  test('on a database board there is no commit switch to find', async () => {
    render(
      <SettingsView
        activeProject={project}
        data={tierData({ myTier: 'operator' })}
      />,
      { wrapper: withQueryClient() }
    );
    search('auto-commit');
    await settleReads();
    expect(
      screen.queryByRole('switch', { name: /Commit task files/ })
    ).toBeNull();
    expect(screen.getByText('No settings match')).toBeDefined();
  });
});

// App folds whole views (Usage, Runs) into Settings as pages.
test('a hosted page joins the rail and renders full width', () => {
  render(
    <SettingsView
      activeProject={project}
      data={data}
      hostedPages={[
        {
          id: 'runs',
          label: 'Runs',
          icon: Bot,
          intro: 'Every run.',
          render: () => <p>every run here</p>,
        },
      ]}
    />
  );
  const runs = navLink('Runs');
  expect(runs.getAttribute('href')).toBe('#/runs');
  fireEvent.click(runs);
  expect(screen.getByText('every run here')).toBeTruthy();
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Runs');
  expect(navLink('Runs').getAttribute('aria-current')).toBe('page');
  // The Activity group holds the hosted pages.
  expect(
    within(screen.getByRole('group', { name: 'Activity' }))
      .getAllByRole('link')
      .map((link) => link.textContent)
  ).toEqual(['Runs']);
});

test('Classic shows no hosted pages', () => {
  render(<SettingsView activeProject={project} data={data} />);
  expect(
    within(screen.getByRole('navigation', { name: 'Settings' })).queryByRole(
      'link',
      { name: 'Runs' }
    )
  ).toBeNull();
  expect(screen.queryByRole('group', { name: 'Activity' })).toBeNull();
});

// Settings renders in the shell's main column: no header row and no close
// button (the crumbs name the place; Escape or any navigation leaves it).
test('the page root carries the settings-panel test id and has no close button', () => {
  render(<SettingsView activeProject={project} data={data} />);
  expect(screen.getByTestId('settings-panel')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Close settings' })).toBeNull();
  // The empty state keeps the test id too: the place is still Settings.
  render(<SettingsView activeProject={null} data={data} />);
  expect(screen.getAllByTestId('settings-panel')).toHaveLength(2);
});

// Rail links are real hrefs (a middle click opens the page in a new tab).
test('every rail link is the page’s own Settings href', () => {
  render(<SettingsView activeProject={project} data={data} />);
  expect(navLink('General').getAttribute('href')).toBe('#/settings/general');
  expect(navLink('Linear').getAttribute('href')).toBe(
    '#/settings/integrations'
  );
  expect(navLink('Connected agents').getAttribute('href')).toBe(
    '#/settings/connected-agents'
  );
});

test('picking a page tells the host, from the rail or from search results', () => {
  const picked: string[] = [];
  render(
    <SettingsView
      activeProject={project}
      data={searchData}
      onSelectPage={(page) => picked.push(page)}
    />,
    { wrapper: withQueryClient() }
  );
  selectPage('Members');
  expect(picked).toEqual(['team']);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Members');
  search('webhook');
  const results = screen.getByRole('region', { name: 'Notifications' });
  fireEvent.click(
    within(results).getByRole('button', { name: 'Notifications' })
  );
  expect(picked).toEqual(['team', 'notifications']);
  expect(screen.getByLabelText<HTMLInputElement>('Search settings').value).toBe(
    ''
  );
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
    'Notifications'
  );
});

// Records the Escapes that would reach the app's own listener: useGlobalKeyboard
// listens on window and returns early on a key something already handled.
function appEscapes(): { count: () => number; stop: () => void } {
  let seen = 0;
  const listener = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !event.defaultPrevented) seen += 1;
  };
  window.addEventListener('keydown', listener);
  return {
    count: () => seen,
    stop: () => window.removeEventListener('keydown', listener),
  };
}

test('Escape in a search with text clears it and stops there', () => {
  render(<SettingsView activeProject={project} data={searchData} />, {
    wrapper: withQueryClient(),
  });
  search('no such setting');
  expect(screen.getByText('No settings match')).toBeDefined();
  const field = screen.getByLabelText<HTMLInputElement>('Search settings');
  const app = appEscapes();
  const passed = fireEvent.keyDown(field, { key: 'Escape' });
  app.stop();
  expect(passed).toBe(false);
  expect(field.value).toBe('');
  expect(app.count()).toBe(0);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('General');
});

test('Escape in an empty search reaches the app, which closes Settings', () => {
  render(<SettingsView activeProject={project} data={data} />);
  const field = screen.getByLabelText<HTMLInputElement>('Search settings');
  const app = appEscapes();
  const passed = fireEvent.keyDown(field, { key: 'Escape' });
  app.stop();
  expect(passed).toBe(true);
  expect(app.count()).toBe(1);
});

// From the old floating panel's tests: a picker open inside Settings takes
// Escape first, so the same press never also closes Settings.
test('Escape in an open picker closes the picker, not Settings', () => {
  render(
    <SettingsView activeProject={project} data={data} initialPage="agents" />,
    { wrapper: withQueryClient() }
  );
  fireEvent.click(selectTrigger('Coding runs effort'));
  const list = screen.getByRole('listbox');
  const app = appEscapes();
  fireEvent.keyDown(document.activeElement ?? list, { key: 'Escape' });
  app.stop();
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(app.count()).toBe(0);
  expect(screen.getByTestId('settings-panel')).toBeTruthy();
});

// The app's own keyboard (useGlobalKeyboard on window), recording each command it
// would run, so a test sees what a key does in the app and not only in Settings.
function AppKeys({ commands }: { commands: GlobalKeyCommand[] }) {
  useGlobalKeyboard({ onCommand: (command) => commands.push(command) });
  return null;
}

// Settings is a place, not a modal, so the app's shortcuts work in it; an open
// picker still owns every letter typed into its list, matched or not.
test('letters typed in an open picker never reach the app’s shortcuts', () => {
  const commands: GlobalKeyCommand[] = [];
  render(
    <>
      <AppKeys commands={commands} />
      <SettingsView activeProject={project} data={data} initialPage="agents" />
    </>,
    { wrapper: withQueryClient() }
  );
  // Low, Medium and High: no option starts with g, h, c or ?.
  fireEvent.click(selectTrigger('Coding runs effort'));
  const list = screen.getByRole('listbox');
  for (const key of ['g', 'h', 'c', '?', '[']) {
    fireEvent.keyDown(document.activeElement ?? list, { key });
  }
  expect(commands).toEqual([]);
  expect(screen.getByRole('listbox')).toBeTruthy();
  // Outside the picker the same letter is the app's again.
  fireEvent.keyDown(document.activeElement ?? list, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.keyDown(screen.getByRole('heading', { level: 1 }), { key: 'c' });
  expect(commands).toEqual(['new-task']);
});

// The Usage page's session detail is a modal SlideOver rendered in place, so it
// sits inside the Settings page, aria-modal while open and a layer of the
// overlay stack: its Escape closes it alone, the app's keyboard stays quiet and
// Settings stays open.
test('the Usage page’s session detail takes its own Escape, not Settings’', async () => {
  const commands: GlobalKeyCommand[] = [];
  function Usage() {
    const [sessionId, setSessionId] = useState<string | null>('s1');
    return (
      <SessionDetailModal
        sessionId={sessionId}
        onClose={() => setSessionId(null)}
      />
    );
  }
  render(
    <>
      <AppKeys commands={commands} />
      <SettingsView
        activeProject={project}
        data={data}
        initialPage="usage"
        hostedPages={[
          {
            id: 'usage',
            label: 'Usage',
            icon: Coins,
            intro: 'Every agent session and what it cost.',
            render: () => <Usage />,
          },
        ]}
      />
    </>,
    { wrapper: withQueryClient() }
  );
  const page = screen.getByTestId('settings-panel');
  const detail = await screen.findByRole('dialog', { name: /session/i });
  expect(page.contains(detail)).toBe(true);
  expect(detail.getAttribute('aria-modal')).toBe('true');
  fireEvent.keyDown(detail, { key: 'Escape' });
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: /session/i })).toBeNull()
  );
  expect(commands).toEqual([]);
  expect(screen.getByTestId('settings-panel')).toBeTruthy();
});
