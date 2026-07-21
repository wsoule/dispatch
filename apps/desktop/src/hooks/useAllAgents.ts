import type { RunMeta } from '@dispatch/client';
import { createApiClient } from '@dispatch/client';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import { isTerminalRunState } from '../lib/runState';
import { ensureDispatchd } from '../lib/tauri';
import type { ProjectSummary } from '../lib/types';

export interface LiveAgentRun {
  run: RunMeta;
  project: ProjectSummary;
}

export interface AllAgentsData {
  liveRuns: LiveAgentRun[];
  loading: boolean;
}

/**
 * The "All Agents" global view needs every live run across every dispatch-enabled project at
 * once, not just the active one — `useDispatchProject` only ever tracks a single project's
 * sidecar. This spawns/ensures a dispatchd for each dispatch-enabled project (the same
 * `ensure_dispatchd` call `useDispatchProject` makes, just fanned out) and polls each one's
 * run list on a plain interval rather than opening N separate WebSockets — simpler, and the
 * few-second latency is fine for a cross-project glance view rather than the actively-worked
 * single-project surfaces that need instant WS updates.
 */
export function useAllAgents(
  dispatchProjects: ProjectSummary[]
): AllAgentsData {
  const portQueries = useQueries({
    queries: dispatchProjects.map((project) => ({
      queryKey: ['dispatchd-port', project.path],
      queryFn: () => ensureDispatchd(project.path),
      staleTime: Infinity,
      retry: false,
    })),
  });

  const runsQueries = useQueries({
    queries: dispatchProjects.map((_project, i) => {
      const port = portQueries[i]?.data;
      return {
        queryKey: ['dispatch-runs', port],
        queryFn: () => {
          if (port === undefined) throw new Error('dispatchd port not ready');
          return createApiClient(`http://127.0.0.1:${port}`).fetchRuns();
        },
        enabled: port !== undefined,
        refetchInterval: 4000,
      };
    }),
  });

  const liveRuns = useMemo(() => {
    const collected: LiveAgentRun[] = [];
    dispatchProjects.forEach((project, i) => {
      const runs = runsQueries[i]?.data ?? [];
      for (const run of runs) {
        if (!isTerminalRunState(run.state)) {
          collected.push({ run, project });
        }
      }
    });
    // Newest-first, matching every other run list in the app.
    collected.sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt));
    return collected;
  }, [dispatchProjects, runsQueries]);

  const loading =
    dispatchProjects.length > 0 &&
    runsQueries.every((q) => q.data === undefined && q.isLoading);

  return { liveRuns, loading };
}
