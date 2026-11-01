import { ApiError, LINEAR_USAGE_LIMIT_MESSAGE } from '@dispatch/client';
import type {
  LinearCapacity,
  LinearCoverage,
  LinearExportScope,
  LinearStatus,
} from '@dispatch/client';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { accessFor, SettingsAccessProvider } from './access';
import { dataWith, testConfig } from './fixtures.test-helper';
import { LinearPanel } from './LinearPanel';

// Whether a locked settings group has disabled this control. happy-dom does
// not carry a disabled fieldset down to its controls, so read the fieldset.
function lockedByGroup(element: HTMLElement): boolean {
  return element.closest('fieldset')?.disabled === true;
}

// An env key can't be disconnected from here, so the row that offers to isn't shown at all —
// only the note explaining where the key came from, next to a still-open connect input. The
// rest of the sync settings (team picker etc.) must still render — this project is connected,
// just not on its own key.
test('an env-sourced key hides Disconnect, says where the key came from, and keeps sync settings', () => {
  render(
    <LinearPanel data={dataWith({ keySource: 'env', connected: true })} />
  );
  expect(screen.queryByRole('button', { name: /Disconnect/ })).toBeNull();
  expect(screen.getByText(/LINEAR_API_KEY/)).toBeDefined();
  expect(screen.getByPlaceholderText('Linear API key')).toBeDefined();
  expect(screen.getByText('Teams')).toBeDefined();
});

const TEAMS = [
  { id: 'team-1', key: 'HYD', name: 'Hydrogen' },
  { id: 'team-2', key: 'OPS', name: 'Ops' },
  { id: 'team-3', key: 'SEC', name: 'Security' },
];

// Every workspace team is a checkbox; linking one appends it, unlinking drops it, and
// "Make primary" moves a linked team to the front, where new issues go.
test('links and unlinks teams, and picks the primary', () => {
  const patches: unknown[] = [];
  render(
    <LinearPanel
      data={dataWith({
        keySource: 'project',
        connected: true,
        linearTeams: TEAMS,
        config: {
          ...testConfig,
          linear: {
            ...testConfig.linear,
            teamId: 'team-1',
            teamIds: ['team-1', 'team-2'],
          },
        },
        handleUpdateConfig: (patch: unknown) => {
          patches.push(patch);
          return Promise.resolve();
        },
      })}
    />
  );
  const box = (name: string) =>
    screen.getByRole('checkbox', { name: `Link ${name}` });
  expect(box('Hydrogen').getAttribute('aria-checked')).toBe('true');
  expect(box('Security').getAttribute('aria-checked')).toBe('false');
  expect(screen.getByText(/Primary: new issues go here/)).toBeDefined();

  fireEvent.click(box('Security'));
  fireEvent.click(box('Hydrogen'));
  fireEvent.click(screen.getByRole('button', { name: 'Make primary' }));
  expect(patches).toEqual([
    { linear: { teamIds: ['team-1', 'team-2', 'team-3'] } },
    { linear: { teamIds: ['team-2'] } },
    { linear: { teamIds: ['team-2', 'team-1'] } },
  ]);
});

// A config from a daemon that predates several teams names only `teamId`.
test('reads a legacy single teamId as the linked team', () => {
  const { teamIds: _dropped, ...legacy } = {
    ...testConfig.linear,
    teamId: 'team-3',
  };
  render(
    <LinearPanel
      data={dataWith({
        keySource: 'project',
        connected: true,
        linearTeams: TEAMS,
        config: {
          ...testConfig,
          linear: legacy as typeof testConfig.linear,
        },
      })}
    />
  );
  expect(
    screen
      .getByRole('checkbox', { name: 'Link Security' })
      .getAttribute('aria-checked')
  ).toBe('true');
});

// The reported symptom: the picker opened with nothing in it and no reason.
test('a failed team fetch explains the empty picker and offers a retry', () => {
  render(
    <LinearPanel
      data={dataWith({
        keySource: 'project',
        connected: true,
        linearTeams: [],
        linearTeamsError: new ApiError('Unauthorized', 401),
      })}
    />
  );
  expect(screen.getByText(/rejected this key/)).toBeDefined();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
});

// Pins the button to actual behaviour, not just its presence — a deleted
// onClick would still pass a "the button exists" assertion.
test('clicking Retry on a failed team fetch calls refetchLinearTeams', () => {
  let calls = 0;
  render(
    <LinearPanel
      data={dataWith({
        keySource: 'project',
        connected: true,
        linearTeams: [],
        linearTeamsError: new ApiError('Unauthorized', 401),
        refetchLinearTeams: () => {
          calls += 1;
        },
      })}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(calls).toBe(1);
});

// The key decides whose Linear account the board goes to, so setting or
// removing it is the owner's; importing and syncing only use it.
test('below the operator tier, the key cannot change but import and sync still run', () => {
  const { unmount } = render(
    <SettingsAccessProvider access={accessFor('decide', false)}>
      <LinearPanel data={dataWith({ keySource: 'env', connected: true })} />
    </SettingsAccessProvider>
  );
  expect(
    screen.getByPlaceholderText<HTMLInputElement>('Linear API key').disabled
  ).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Connect' }).disabled
  ).toBe(true);
  // No team is chosen in this fixture, so these are disabled for that reason;
  // what matters here is that no tier lock reaches them.
  expect(
    lockedByGroup(screen.getByRole('button', { name: 'Import from Linear' }))
  ).toBe(false);
  expect(lockedByGroup(screen.getByRole('button', { name: /Sync now/ }))).toBe(
    false
  );
  unmount();

  render(
    <SettingsAccessProvider access={accessFor('decide', false)}>
      <LinearPanel data={dataWith({ keySource: 'project', connected: true })} />
    </SettingsAccessProvider>
  );
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: /Disconnect/ })
      .disabled
  ).toBe(true);
});

test('a project-sourced key leaves Disconnect enabled', () => {
  render(
    <LinearPanel data={dataWith({ keySource: 'project', connected: true })} />
  );
  const button: HTMLButtonElement = screen.getByRole('button', {
    name: /Disconnect/,
  });
  expect(button.disabled).toBe(false);
  expect(screen.queryByPlaceholderText('Linear API key')).toBeNull();
});

// The shared machine-wide key is a read-only fallback — there is no Disconnect for it, only
// the note inviting the user to give this project its own key instead.
test('a global-sourced key hides Disconnect and invites a project override', () => {
  render(
    <LinearPanel data={dataWith({ keySource: 'global', connected: true })} />
  );
  expect(screen.queryByRole('button', { name: /Disconnect/ })).toBeNull();
  expect(screen.getByText(/shared default key/)).toBeDefined();
});

// Sync is a row whose title labels a `Switch`; the API-key field is the 13px book-weight
// `Input` with no code face, and the poll interval is sans with tabular digits.
test('sync is a switch and the key and interval inputs are sans', () => {
  render(
    <LinearPanel data={dataWith({ keySource: 'env', connected: true })} />
  );
  expect(
    screen.getByRole('switch', { name: 'Sync this project with Linear' })
  ).toBeDefined();
  const key = screen.getByPlaceholderText('Linear API key');
  expect(key.className).toContain('text-[13px]');
  expect(key.className).toContain('font-book');
  expect(key.className).not.toContain('font-mono');
  const interval = screen.getByLabelText('Poll interval');
  expect(interval.className).toContain('tabular-nums');
  expect(interval.className).not.toContain('font-mono');
});

// With a team linked, each lifecycle role picks one of the team's statuses;
// landing may be left at None.
test('lists the status roles with their current choice', () => {
  const data = dataWith({
    keySource: 'project',
    connected: true,
    config: {
      ...testConfig,
      statuses: ['Todo', 'In Progress', 'In Review', 'Done', 'Canceled'],
      statusRoles: {
        ready: 'Todo',
        dispatched: 'In Progress',
        review: 'In Review',
        landing: null,
        landed: 'Done',
        dropped: 'Canceled',
      },
      linear: { ...testConfig.linear, teamId: 'team-1', teamIds: ['team-1'] },
    },
  });
  render(<LinearPanel data={data} />);

  expect(screen.getByText('Status roles')).toBeDefined();
  const review = screen.getByRole('combobox', { name: 'Run finishes status' });
  expect(review.textContent).toContain('In Review');
  const landing = screen.getByRole('combobox', { name: 'Merge queue status' });
  expect(landing.textContent).toContain('None');
});

test('says how changes arrive and how many conflicts were resolved', () => {
  const base = dataWith({ keySource: 'project', connected: true });
  if (base.linearStatus === null) throw new Error('fixture carries a status');
  const linearStatus = {
    ...base.linearStatus,
    conflicts: { total: 3, recent: [] },
    progress: { phase: 'issues' as const, done: 1200, total: null },
    webhook: {
      state: 'active' as const,
      url: 'https://dispatch.example.com/api/linear/webhook',
      lastDeliveryAt: null,
      error: null,
      pollSec: 300,
    },
  };
  render(<LinearPanel data={{ ...base, linearStatus }} />);

  expect(
    screen.getByText(/Linear delivers changes as they happen/)
  ).toBeDefined();
  expect(screen.getByText(/3 field\(s\) changed on both sides/)).toBeDefined();
  expect(screen.getByText('Fetching issues… 1,200')).toBeDefined();
});

// Connecting, importing and syncing are Linear's own routes, open to any
// teammate; the sync settings are config, which needs Can approve.
test('below the decide tier, connect and sync stay usable and the sync settings lock', () => {
  const base = dataWith({ keySource: 'env', connected: true });
  const data = {
    ...base,
    linearTeams: [{ id: 'team-1', key: 'ENG', name: 'Engineering' }],
  };
  render(
    <SettingsAccessProvider access={accessFor('request', false)}>
      <LinearPanel data={data} />
    </SettingsAccessProvider>
  );
  expect(lockedByGroup(screen.getByPlaceholderText('Linear API key'))).toBe(
    false
  );
  expect(
    lockedByGroup(screen.getByRole('button', { name: 'Import from Linear' }))
  ).toBe(false);
  expect(lockedByGroup(screen.getByRole('button', { name: /Sync now/ }))).toBe(
    false
  );
  expect(
    lockedByGroup(
      screen.getByRole('switch', { name: 'Sync this project with Linear' })
    )
  ).toBe(true);
  expect(
    lockedByGroup(screen.getByRole('checkbox', { name: 'Link Engineering' }))
  ).toBe(true);
  expect(lockedByGroup(screen.getByLabelText('Poll interval'))).toBe(true);
  expect(
    lockedByGroup(
      screen.getByRole('switch', { name: 'Send Acceptance Criteria to Linear' })
    )
  ).toBe(true);
});

// Connected on the project's key with team-1 linked and synced once: every
// Linear group shows. `status` overrides the daemon's status fields.
function linked(
  overrides: Partial<DispatchProjectData> = {},
  status: Partial<LinearStatus> = {}
): DispatchProjectData {
  const base = dataWith({
    keySource: 'project',
    connected: true,
    linearTeams: [{ id: 'team-1', key: 'HYD', name: 'Hydrogen' }],
    config: {
      ...testConfig,
      linear: { ...testConfig.linear, teamId: 'team-1', teamIds: ['team-1'] },
    },
    ...overrides,
  });
  if (base.linearStatus === null) throw new Error('fixture carries a status');
  return {
    ...base,
    linearStatus: {
      ...base.linearStatus,
      teamId: 'team-1',
      teamIds: ['team-1'],
      bootstrappedAt: '2026-10-20T00:00:00.000Z',
      ...status,
    },
  };
}

const COUNTS = {
  total: 309,
  linked: 10,
  notLinked: 299,
  heldBack: 297,
  queued: 0,
  failed: 2,
  excluded: 0,
};

const PREVIEW = {
  open: 47,
  all: 309,
  allArchiveFinished: 320,
  finished: 262,
  archived: 11,
  derived: 0,
  containers: 3,
};

// The row a control or line sits in, by the row's title.
function row(title: string): HTMLElement {
  const found = screen
    .getAllByText(title)
    .map((el) => el.closest<HTMLElement>('[data-settings-row]'))
    .find((el) => el !== null);
  if (found === undefined || found === null) throw new Error(`no row ${title}`);
  return found;
}

test('archiving finished tasks in Linear is a switch that patches linear.archiveFinished', () => {
  const patches: unknown[] = [];
  render(
    <LinearPanel
      data={linked({
        handleUpdateConfig: (patch: unknown) => {
          patches.push(patch);
          return Promise.resolve();
        },
      })}
    />
  );
  const toggle = screen.getByRole('switch', {
    name: 'Archive finished tasks in Linear too',
  });
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(screen.getByText(/completed or canceled task/)).toBeDefined();
  fireEvent.click(toggle);
  expect(patches).toEqual([{ linear: { archiveFinished: true } }]);
});

test('below the decide tier the archive-finished switch locks with the sync settings', () => {
  render(
    <SettingsAccessProvider access={accessFor('request', false)}>
      <LinearPanel data={linked()} />
    </SettingsAccessProvider>
  );
  expect(
    lockedByGroup(
      screen.getByRole('switch', {
        name: 'Archive finished tasks in Linear too',
      })
    )
  ).toBe(true);
});

test('offers an export when tasks predate the link and none has run', () => {
  const { unmount } = render(
    <LinearPanel data={linked({}, { coverage: COUNTS, lastExport: null })} />
  );
  const offer = screen.getByTestId('linear-export-offer');
  // The two failed creates have Retry under Coverage instead.
  expect(offer.textContent).toContain('297 tasks here aren’t in Linear yet');
  expect(
    within(offer).getByRole('button', { name: 'Export to Linear…' })
  ).toBeDefined();
  unmount();

  // Once an export has run, the row stays but the offer goes.
  render(
    <LinearPanel
      data={linked(
        {},
        {
          coverage: COUNTS,
          lastExport: {
            action: 'export',
            startedAt: '2026-10-21T00:00:00.000Z',
            at: '2026-10-21T00:01:00.000Z',
            scope: 'open',
            candidates: 47,
            done: 47,
            remaining: 0,
            halted: null,
            errors: [],
          },
        }
      )}
    />
  );
  expect(screen.queryByTestId('linear-export-offer')).toBeNull();
  expect(screen.getByText('Exported 47 of 47')).toBeDefined();
});

test('makes no export offer for tasks made after the link, waiting or failed', () => {
  render(
    <LinearPanel
      data={linked(
        {},
        {
          coverage: { ...COUNTS, notLinked: 3, heldBack: 0, failed: 2 },
          lastExport: null,
        }
      )}
    />
  );
  expect(screen.queryByTestId('linear-export-offer')).toBeNull();
});

test('Export to Linear lists three scopes with counts and sends the chosen one', async () => {
  const handleExportLinear = mock((_scope: LinearExportScope) =>
    Promise.resolve({ started: true, candidates: 320 })
  );
  render(
    <LinearPanel
      data={linked({ linearExportPreview: PREVIEW, handleExportLinear })}
    />
  );
  fireEvent.click(
    within(row('Export to Linear')).getByRole('button', {
      name: 'Export to Linear…',
    })
  );
  const dialog = await screen.findByRole('dialog');
  expect(
    within(dialog).getByRole('radio', { name: /Open work only\s*47 tasks/ })
  ).toBeDefined();
  expect(
    within(dialog).getByRole('radio', { name: /^Everything\s*309 tasks/ })
  ).toBeDefined();
  fireEvent.click(
    within(dialog).getByRole('radio', {
      name: /Everything, finished tasks archived on arrival\s*320 tasks/,
    })
  );
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Export 320 tasks' })
  );
  await waitFor(() => expect(handleExportLinear).toHaveBeenCalledTimes(1));
  expect(handleExportLinear.mock.calls[0]).toEqual(['all-archive-finished']);
});

test('the export dialog says when the workspace cannot fit the export', async () => {
  const cap: LinearCapacity = {
    teams: [],
    active: 240,
    activeScope: 'workspace',
    limit: 250,
    limitSource: 'plan',
    plan: 'free',
    limitHitAt: null,
    truncated: false,
    checkedAt: '2026-10-25T00:00:00.000Z',
  };
  render(
    <LinearPanel
      data={linked({ linearExportPreview: PREVIEW, linearCapacity: cap })}
    />
  );
  fireEvent.click(
    within(row('Export to Linear')).getByRole('button', {
      name: 'Export to Linear…',
    })
  );
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toContain('This export adds 47 and 10 are free');
});

// The open tasks fill every free slot, leaving none for an arrival to land in.
test('the export dialog counts the slot an archived arrival needs', async () => {
  const cap: LinearCapacity = {
    teams: [],
    active: 240,
    activeScope: 'workspace',
    limit: 250,
    limitSource: 'plan',
    plan: 'free',
    limitHitAt: null,
    truncated: false,
    checkedAt: '2026-10-25T00:00:00.000Z',
  };
  render(
    <LinearPanel
      data={linked({
        linearExportPreview: { ...PREVIEW, open: 10 },
        linearCapacity: cap,
      })}
    />
  );
  fireEvent.click(
    within(row('Export to Linear')).getByRole('button', {
      name: 'Export to Linear…',
    })
  );
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toContain('This export fits.');
  fireEvent.click(
    within(dialog).getByRole('radio', {
      name: /Everything, finished tasks archived on arrival/,
    })
  );
  expect(dialog.textContent).not.toContain('This export fits.');
  expect(dialog.textContent).toContain(
    'Its 10 open issues fill the 10 free slots, so the 310 archived on arrival wait in the retry queue'
  );
});

test('export progress shows under Export, not under Import', () => {
  render(
    <LinearPanel
      data={linked(
        {},
        {
          progress: { phase: 'creating', done: 3, total: 47, action: 'export' },
          running: { action: 'export', startedAt: '2026-10-25T00:00:00.000Z' },
        }
      )}
    />
  );
  expect(
    within(row('Export to Linear')).getByText('Creating issues… 3 of 47')
  ).toBeDefined();
  expect(
    within(row('Import from Linear')).queryByText(/Creating issues/)
  ).toBeNull();
  // A second export cannot start while one runs.
  expect(
    within(row('Export to Linear')).getByRole<HTMLButtonElement>('button', {
      name: 'Export to Linear…',
    }).disabled
  ).toBe(true);
});

test('a pass that hit the issue limit says so once', () => {
  const lastSummary = {
    at: '2026-10-25T00:00:00.000Z',
    pulled: 0,
    pushed: 0,
    created: 0,
    createdIssues: 0,
    conflicts: 0,
    errors: [],
    rateLimited: false,
    usageLimited: true,
  };
  const { unmount } = render(
    <LinearPanel data={linked({}, { lastSummary })} />
  );
  expect(screen.getAllByText(LINEAR_USAGE_LIMIT_MESSAGE)).toHaveLength(1);
  unmount();

  render(
    <LinearPanel
      data={linked(
        {},
        {
          lastSummary: { ...lastSummary, errors: [LINEAR_USAGE_LIMIT_MESSAGE] },
        }
      )}
    />
  );
  expect(screen.getAllByText(LINEAR_USAGE_LIMIT_MESSAGE)).toHaveLength(1);
});

test('the pass that adopted the team’s workflow says how many tasks moved', () => {
  render(
    <LinearPanel
      data={linked(
        {},
        {
          lastSummary: {
            at: '2026-10-25T00:00:00.000Z',
            pulled: 0,
            pushed: 0,
            created: 0,
            createdIssues: 0,
            conflicts: 0,
            errors: [],
            rateLimited: false,
            migrated: 309,
          },
        }
      )}
    />
  );
  expect(
    screen.getByText('Moved 309 tasks onto Hydrogen’s workflow.')
  ).toBeDefined();
});

test('warns when the team has no review state of its own', () => {
  const roles = {
    ready: 'Todo',
    dispatched: 'In Progress',
    review: 'In Progress',
    landing: null,
    landed: 'Done',
    dropped: 'Canceled',
  };
  const config = {
    ...testConfig,
    statuses: ['Todo', 'In Progress', 'Done', 'Canceled'],
    statusRoles: roles,
    linear: { ...testConfig.linear, teamId: 'team-1', teamIds: ['team-1'] },
  };
  const { unmount } = render(<LinearPanel data={linked({ config })} />);
  expect(screen.getByTestId('linear-no-review-state').textContent).toContain(
    'Finished runs stay in In Progress in Linear'
  );
  unmount();

  render(
    <LinearPanel
      data={linked({
        config: {
          ...config,
          statuses: [...config.statuses, 'In Review'],
          statusRoles: { ...roles, review: 'In Review' },
        },
      })}
    />
  );
  expect(screen.queryByTestId('linear-no-review-state')).toBeNull();
});

const COVERAGE: LinearCoverage = {
  total: 309,
  linked: 10,
  notLinked: 3,
  excluded: { derived: 2 },
  byEntity: { issue: 10, project: 0, milestone: 0, initiative: 0 },
  counts: {
    failed: 1,
    'at-capacity': 0,
    queued: 0,
    'moved-out': 1,
    'pull-only': 0,
    'held-back': 1,
    pending: 0,
  },
  unlinked: [
    {
      id: 't-abc',
      title: 'Fix checkout',
      kind: 'task',
      status: 'Todo',
      finished: false,
      archived: false,
      reason: 'failed',
      attempts: 2,
      lastError: 'duplicate label name',
      lastAttemptAt: '2026-10-25T00:00:00.000Z',
      retryAt: null,
    },
    {
      id: 't-moved',
      title: 'Moved away',
      kind: 'task',
      status: 'Todo',
      finished: false,
      archived: false,
      reason: 'moved-out',
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
      retryAt: null,
    },
    {
      id: 't-old',
      title: 'Old work',
      kind: 'task',
      status: 'Done',
      finished: true,
      archived: false,
      reason: 'held-back',
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
      retryAt: null,
    },
  ],
};

test('Coverage counts linked tasks and lists the rest with their reason', async () => {
  render(<LinearPanel data={linked({ linearCoverage: COVERAGE })} />);
  expect(
    screen.getByText('10 of 309 tasks · 2 PR review tasks never sync')
  ).toBeDefined();
  expect(
    screen.getByRole('progressbar', { name: 'Tasks in Linear' })
  ).toBeDefined();
  expect(
    screen.getByText('1 failed · 1 left the linked teams · 1 held back')
  ).toBeDefined();

  fireEvent.click(screen.getByRole('button', { name: 'Show 3 tasks' }));
  const rows = await screen.findAllByTestId('linear-unlinked-row');
  expect(rows).toHaveLength(3);
  expect(within(rows[0]).getByText('Failed')).toBeDefined();
  expect(within(rows[0]).getByText('duplicate label name')).toBeDefined();
  expect(within(rows[1]).getByText('Left team')).toBeDefined();
  expect(within(rows[1]).queryByRole('button')).toBeNull();
  expect(within(rows[2]).getByText('Held back')).toBeDefined();
  // Each row's actions are named for their task, not just "Send".
  expect(
    within(rows[2]).getByRole('button', { name: 'Send Old work' })
  ).toBeDefined();
  expect(
    within(rows[0]).getByRole('button', { name: 'Retry Fix checkout' })
  ).toBeDefined();
});

test('Coverage says why it cannot count instead of counting forever', () => {
  render(
    <LinearPanel
      data={linked(
        { linearCoverageError: new Error('not found: /api/linear/coverage') },
        { coverage: undefined }
      )}
    />
  );
  expect(
    within(row('In Linear')).getByText(
      'Couldn’t count: not found: /api/linear/coverage'
    )
  ).toBeDefined();
});

test('a failed row retries or stops retrying exactly that task', async () => {
  const handleRetryLinear = mock((_taskIds?: string[]) =>
    Promise.resolve({ started: true, candidates: 1 })
  );
  const handleForgetLinear = mock((_taskIds: string[]) =>
    Promise.resolve({ forgotten: 1 })
  );
  render(
    <LinearPanel
      data={linked({
        linearCoverage: COVERAGE,
        handleRetryLinear,
        handleForgetLinear,
      })}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry now (1)' }));
  await waitFor(() => expect(handleRetryLinear).toHaveBeenCalledTimes(1));
  expect(handleRetryLinear.mock.calls[0]).toEqual([['t-abc']]);

  fireEvent.click(screen.getByRole('button', { name: 'Show 3 tasks' }));
  const [failed] = await screen.findAllByTestId('linear-unlinked-row');
  fireEvent.click(
    within(failed).getByRole('button', { name: 'Retry Fix checkout' })
  );
  await waitFor(() => expect(handleRetryLinear).toHaveBeenCalledTimes(2));
  expect(handleRetryLinear.mock.calls[1]).toEqual([['t-abc']]);
  fireEvent.click(
    within(failed).getByRole('button', {
      name: 'Stop retrying Fix checkout',
    })
  );
  await waitFor(() => expect(handleForgetLinear).toHaveBeenCalledTimes(1));
  expect(handleForgetLinear.mock.calls[0]).toEqual([['t-abc']]);
});

test('a pull-only project offers no export and no Send', async () => {
  const config = {
    ...testConfig,
    linear: {
      ...testConfig.linear,
      teamId: 'team-1',
      teamIds: ['team-1'],
      direction: 'pull' as const,
    },
  };
  render(
    <LinearPanel
      data={linked(
        {
          config,
          linearCoverage: {
            ...COVERAGE,
            counts: { ...COVERAGE.counts, 'pull-only': 1, 'held-back': 0 },
            unlinked: [{ ...COVERAGE.unlinked[2], reason: 'pull-only' }],
          },
        },
        { direction: 'pull', coverage: COUNTS }
      )}
    />
  );
  expect(screen.queryByTestId('linear-export-offer')).toBeNull();
  expect(
    within(row('Export to Linear')).getByRole<HTMLButtonElement>('button', {
      name: 'Export to Linear…',
    }).disabled
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Show 1 tasks' }));
  const [pullOnly] = await screen.findAllByTestId('linear-unlinked-row');
  expect(within(pullOnly).queryByRole('button')).toBeNull();
});

const CAPACITY: LinearCapacity = {
  teams: [
    {
      id: 'team-1',
      key: 'HYD',
      name: 'Hydrogen',
      active: 188,
      completed: 120,
      canceled: 20,
    },
  ],
  active: 188,
  activeScope: 'workspace',
  limit: 250,
  limitSource: 'plan',
  plan: 'free',
  limitHitAt: null,
  truncated: false,
  checkedAt: '2026-10-25T00:00:00.000Z',
};

test('Capacity shows active issues against the Free plan’s limit', async () => {
  const refreshLinearCapacity = mock(() => Promise.resolve());
  render(
    <LinearPanel
      data={linked({ linearCapacity: CAPACITY, refreshLinearCapacity })}
    />
  );
  expect(
    screen.getByText(
      '188 of 250 active issues in the workspace on the Free plan'
    )
  ).toBeDefined();
  const bar = screen.getByRole('progressbar', {
    name: 'Active issues against the limit',
  });
  expect(bar.getAttribute('aria-valuenow')).toBe('75');
  const checkAgain = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Check again',
  });
  fireEvent.click(checkAgain);
  expect(refreshLinearCapacity).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(checkAgain.disabled).toBe(false));
});

test('while creates are paused at the limit, Capacity says when they resume', () => {
  render(
    <LinearPanel
      data={linked(
        { linearCapacity: CAPACITY },
        {
          capacity: {
            limitedAt: new Date().toISOString(),
            retryAt: new Date(Date.now() + 25 * 60_000).toISOString(),
            message: LINEAR_USAGE_LIMIT_MESSAGE,
            active: 250,
            limit: 250,
            limitSource: 'plan',
            plan: 'free',
            checkedAt: null,
          },
          lastError: LINEAR_USAGE_LIMIT_MESSAGE,
        }
      )}
    />
  );
  expect(
    within(row('Active issues')).getByText(LINEAR_USAGE_LIMIT_MESSAGE)
  ).toBeDefined();
  expect(
    within(row('Active issues')).getByText(/Dispatch tries again in 2\dm/)
  ).toBeDefined();
});

test('archiving closed issues confirms first, then sends includeCanceled', async () => {
  const handleArchiveClosedLinear = mock(
    (_opts: { includeCanceled: boolean }) =>
      Promise.resolve({ started: true, candidates: 140 })
  );
  render(
    <LinearPanel
      data={linked({ linearCapacity: CAPACITY, handleArchiveClosedLinear })}
    />
  );
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include canceled' }));
  expect(screen.getByText('Include canceled (20)')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Archive 140…' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog.textContent).toContain('Archive 140 issues in Linear?');
  expect(dialog.textContent).toContain('Completed and canceled issues in HYD');
  expect(dialog.textContent).toContain(
    'the tasks here linked to them are archived too'
  );
  expect(handleArchiveClosedLinear).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
  await waitFor(() =>
    expect(handleArchiveClosedLinear).toHaveBeenCalledTimes(1)
  );
  expect(handleArchiveClosedLinear.mock.calls[0]).toEqual([
    { includeCanceled: true },
  ]);
});

test('on a push-only link the archive says the tasks here stay as they are', async () => {
  const config = {
    ...testConfig,
    linear: {
      ...testConfig.linear,
      teamId: 'team-1',
      teamIds: ['team-1'],
      direction: 'push' as const,
    },
  };
  render(
    <LinearPanel
      data={linked({ config, linearCapacity: CAPACITY }, { direction: 'push' })}
    />
  );
  expect(
    within(row('Archive closed issues in Linear')).getByText(
      /Their tasks here stay as they are/
    )
  ).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Archive 120…' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog.textContent).toContain(
    'The tasks here linked to them stay as they are'
  );
  expect(dialog.textContent).not.toContain('are archived too');
});

test('archiving is off on a pull-only link and before the first sync', () => {
  const config = {
    ...testConfig,
    linear: {
      ...testConfig.linear,
      teamId: 'team-1',
      teamIds: ['team-1'],
      direction: 'pull' as const,
    },
  };
  const { unmount } = render(
    <LinearPanel
      data={linked({ config, linearCapacity: CAPACITY }, { direction: 'pull' })}
    />
  );
  const archive = () =>
    screen.getByRole<HTMLButtonElement>('button', { name: 'Archive 120…' });
  expect(archive().disabled).toBe(true);
  expect(
    screen.getByText(
      'Pull only: switch the direction to archive issues in Linear.'
    )
  ).toBeDefined();
  unmount();

  render(
    <LinearPanel
      data={linked({ linearCapacity: CAPACITY }, { bootstrappedAt: null })}
    />
  );
  expect(archive().disabled).toBe(true);
  expect(screen.getByText('Sync once to link the team first.')).toBeDefined();
});

test('the export dialog says why it cannot count instead of counting forever', async () => {
  render(
    <LinearPanel
      data={linked({
        linearExportPreviewError: new Error('not found: /api/linear/export'),
      })}
    />
  );
  fireEvent.click(
    within(row('Export to Linear')).getByRole('button', {
      name: 'Export to Linear…',
    })
  );
  const dialog = await screen.findByRole('dialog');
  expect(
    within(dialog).getAllByText('Couldn’t count: not found: /api/linear/export')
  ).toHaveLength(3);
});

test('below the decide tier, archiving locks but capacity still shows', () => {
  render(
    <SettingsAccessProvider access={accessFor('request', false)}>
      <LinearPanel data={linked({ linearCapacity: CAPACITY })} />
    </SettingsAccessProvider>
  );
  expect(
    screen.getByText(
      '188 of 250 active issues in the workspace on the Free plan'
    )
  ).toBeDefined();
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Archive 120…' })
      .disabled
  ).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Check again' })
      .disabled
  ).toBe(false);
});

test('the panel watches coverage and capacity only while it is shown', () => {
  let watching = 0;
  const { unmount } = render(
    <LinearPanel
      data={linked({
        watchLinearDetails: () => {
          watching += 1;
          return () => {
            watching -= 1;
          };
        },
      })}
    />
  );
  expect(watching).toBe(1);
  unmount();
  expect(watching).toBe(0);
});
