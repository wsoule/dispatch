import type { DispatchConfig } from '@dispatch/core/browser';
import {
  DEFAULT_CARTO,
  DEFAULT_FIX_LOOP,
  DEFAULT_LINEAR,
  DEFAULT_MODELS,
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
  },
  models: DEFAULT_MODELS,
  linear: DEFAULT_LINEAR,
  fixLoop: DEFAULT_FIX_LOOP,
  carto: DEFAULT_CARTO,
};

export const testProject = { path: '/tmp/demo', name: 'demo' };

/** A `DispatchProjectData` stub carrying only what the settings sections read.
 *  Cast once here so no individual test has to spell out 60 unused fields. */
export function dataWith(
  overrides: Partial<DispatchProjectData> & {
    keySource?: 'env' | 'file' | null;
    connected?: boolean;
  } = {}
): DispatchProjectData {
  const { keySource = null, connected = false, ...rest } = overrides;
  return {
    config: testConfig,
    client: {},
    portLoading: false,
    portError: false,
    tasks: [],
    runs: [],
    linearStatus: {
      enabled: false,
      connected,
      keySource,
      teamId: null,
      direction: 'both',
      intervalSec: 300,
      statusMap: {},
      cursor: null,
      bootstrappedAt: null,
      lastSyncAt: null,
      lastError: null,
      lastSummary: null,
      syncing: false,
    },
    linearTeams: [],
    linearTeamsError: null,
    refetchLinearTeams: () => {},
    linearStates: [],
    linearStatesError: null,
    refetchLinearStates: () => {},
    linearLinks: {},
    handleUpdateConfig: async () => {},
    handleConnectLinear: async () => ({
      connected: true,
      viewer: { name: 'x' },
    }),
    handleDisconnectLinear: async () => {},
    handleSyncLinear: async () => ({}),
    handleImportLinear: async () => ({}),
    ...rest,
  } as unknown as DispatchProjectData;
}
