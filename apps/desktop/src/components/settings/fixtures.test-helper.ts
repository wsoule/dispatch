import type { DispatchConfig } from '@dispatch/core/browser';
import {
  DEFAULT_CARTO,
  DEFAULT_FIX_LOOP,
  DEFAULT_LINEAR,
  DEFAULT_MEMORY,
  DEFAULT_MESSAGING,
  DEFAULT_MODELS,
  DEFAULT_NOTIFICATIONS,
  DEFAULT_REPO_DIGEST,
} from '@dispatch/core/browser';

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
    epicConcurrency: 3,
    verifyTimeoutSec: 600,
    maxConcurrency: 16,
    runCostEstimateUsd: 10,
    executor: 'claude',
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
    whoamiError: null,
    retryWhoami: () => {},
    tasks: [],
    runs: [],
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
    handleSyncLinear: () => Promise.resolve({}),
    handleImportLinear: () => Promise.resolve({}),
    ...rest,
  } as unknown as DispatchProjectData;
}
