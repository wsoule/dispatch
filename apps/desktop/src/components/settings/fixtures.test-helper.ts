import type { DispatchConfig } from '@dispatch-foo/core/browser';
import {
  DEFAULT_CARTO,
  DEFAULT_FIX_LOOP,
  DEFAULT_LINEAR,
  DEFAULT_MEMORY,
  DEFAULT_MESSAGING,
  DEFAULT_MODELS,
  DEFAULT_NOTIFICATIONS,
  DEFAULT_REPO_DIGEST,
} from '@dispatch-foo/core/browser';
import { act, fireEvent, screen } from '@testing-library/react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';

/** The shape `loadConfig` returns for a project with no config.yml — verified
 *  against config.test.ts's "returns defaults when file missing" case. */
export const testConfig: DispatchConfig = {
  statuses: [
    'backlog',
    'todo',
    'in-progress',
    'in-review',
    'done',
    'cancelled',
  ],
  autoCommit: false,
  orchestrator: {
    permissionMode: 'auto',
    milestoneConcurrency: 3,
    verifyTimeoutSec: 600,
    maxConcurrency: 16,
    runCostEstimateUsd: 10,
    unlimitedSpend: false,
    executor: 'claude',
    startDependents: 'landed',
  },
  models: DEFAULT_MODELS,
  linear: DEFAULT_LINEAR,
  fixLoop: DEFAULT_FIX_LOOP,
  carto: DEFAULT_CARTO,
  repoDigest: DEFAULT_REPO_DIGEST,
  notifications: DEFAULT_NOTIFICATIONS,
  messaging: DEFAULT_MESSAGING,
  memory: DEFAULT_MEMORY,
};

/** A Linear team's workflow mirrored into config: none of these names is a built-in,
 *  so a surface still reading the built-in model gets every one of them wrong. */
export const linearWorkflowConfig: DispatchConfig = {
  ...testConfig,
  statuses: ['Backlog', 'Todo', 'In Progress', 'QA', 'Done', 'Canceled'],
  statusDefinitions: [
    { name: 'Backlog', type: 'backlog', color: null },
    { name: 'Todo', type: 'unstarted', color: null },
    { name: 'In Progress', type: 'started', color: null },
    { name: 'QA', type: 'started', color: null },
    { name: 'Done', type: 'completed', color: null },
    { name: 'Canceled', type: 'canceled', color: null },
  ],
  statusRoles: {
    ready: 'Todo',
    dispatched: 'In Progress',
    review: 'QA',
    landing: null,
    landed: 'Done',
    dropped: 'Canceled',
  },
};

export const testProject = { path: '/tmp/demo', name: 'demo' };

/** A `DispatchProjectData` stub carrying only what the settings sections read.
 *  Cast once here so no individual test has to spell out 60 unused fields. */
export function dataWith(
  overrides: Partial<DispatchProjectData> & {
    keySource?: 'project' | 'env' | 'global' | null;
    connected?: boolean;
  } = {}
): DispatchProjectData {
  const { keySource = null, connected = false, ...rest } = overrides;
  return {
    config: testConfig,
    client: {},
    // A database-backed board, the default; the Board sync page waits for this.
    health: { pr: false, storageBackend: 'sqlite' },
    syncStatus: null,
    portLoading: false,
    portError: false,
    // No tier known and not attached: the shell locks config until a test
    // passes `myTier`, the way it does before a connection exists.
    myTier: null,
    attachedWithoutAppToken: false,
    takeover: null,
    whoamiError: null,
    retryWhoami: () => {},
    tasks: [],
    runs: [],
    people: [],
    me: null,
    ownerCredential: false,
    // No messaging: Memory's lessons browser stays a one-line explanation.
    messageAccess: { canDecide: false, canMessage: false, explanation: null },
    linearStatus: {
      enabled: false,
      connected,
      keySource,
      teamId: null,
      direction: 'both',
      intervalSec: 30,
      statusMap: {},
      cursor: null,
      bootstrappedAt: null,
      lastSyncAt: null,
      lastError: null,
      lastSummary: null,
      syncing: false,
      conflicts: { total: 0, recent: [] },
      progress: null,
      webhook: {
        state: 'polling',
        url: null,
        lastDeliveryAt: null,
        error: null,
        pollSec: 30,
      },
      capacity: null,
      coverage: null,
      running: null,
      lastExport: null,
      lastArchive: null,
    },
    linearTeams: [],
    linearTeamsError: null,
    refetchLinearTeams: () => {},
    linearLinks: {},
    handleUpdateConfig: async () => {},
    handleConnectLinear: () =>
      Promise.resolve({
        connected: true,
        viewer: { name: 'x' },
      }),
    handleDisconnectLinear: () => {},
    // Not fetched yet: the account group holds its place with a skeleton.
    linearAccount: null,
    linearAccountError: null,
    handleLinearSignIn: () =>
      Promise.resolve({ authorizeUrl: 'https://linear.app/oauth/authorize?' }),
    handleCancelLinearSignIn: () => Promise.resolve(),
    handleLinearSignOut: () => Promise.resolve({ revoked: true }),
    handleSyncLinear: () => Promise.resolve({}),
    handleImportLinear: () => Promise.resolve({}),
    linearCoverage: null,
    linearCapacity: null,
    linearCapacityError: null,
    linearCoverageError: null,
    linearExportPreviewError: null,
    linearExportPreview: null,
    watchLinearDetails: () => () => {},
    refreshLinearCapacity: () => Promise.resolve(),
    handleExportLinear: () => Promise.resolve({ started: true, candidates: 0 }),
    handleRetryLinear: () => Promise.resolve({ started: true, candidates: 0 }),
    handleForgetLinear: () => Promise.resolve({ forgotten: 0 }),
    handleArchiveClosedLinear: () =>
      Promise.resolve({ started: true, candidates: 0 }),
    ...rest,
  } as unknown as DispatchProjectData;
}

type RoleQueries = Pick<typeof screen, 'getByRole'>;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A settings Select's trigger by the setting's name: the button reads "Name" while
 *  empty and "Name: Value" once chosen. */
export function selectTrigger(
  name: string,
  root: RoleQueries = screen
): HTMLElement {
  return root.getByRole('button', {
    name: new RegExp(`^${escapeRegExp(name)}(: |$)`),
  });
}

/** Picks an option in the open Select (or picker) list. The pick saves, and
 *  the save settles a microtask later (the picker leaves its pending state),
 *  so the act waits for it. */
export async function chooseOption(name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('option', { name }));
    await Promise.resolve();
  });
}

/** Elements printing `text` that a viewer can see: a plain text query also finds copies
 *  inside a `hidden` subtree (a folded Disclosure's kept panel, a hidden tab), which this
 *  filters out. The Tooltip renders its tip only while shown, so it adds none. */
export function visibleText(text: string): HTMLElement[] {
  return screen
    .queryAllByText(text)
    .filter((el) => el.closest('[hidden]') === null);
}
