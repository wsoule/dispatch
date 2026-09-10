import type {
  AdjudicateFindingInput,
  AdjudicateFindingResult,
  ApiClient,
  FixLoopState,
} from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

// Shared root for invalidating a whole event kind at once — finding.changed
// and ledger.changed carry no id, so their handlers invalidate everything here.
const ORCHESTRATION_QUERY_ROOT = 'dispatch-orchestration';

// Every key below namespaces by `port`: findings/fix-loops/ledger live in
// per-worktree `.dispatch/*.jsonl` files sharing task ids across worktrees.
function taskFindingsKey(port: number | undefined, taskId: string | undefined) {
  return [ORCHESTRATION_QUERY_ROOT, 'findings', port, taskId] as const;
}
function fixLoopKey(port: number | undefined, taskId: string | undefined) {
  return [ORCHESTRATION_QUERY_ROOT, 'fix-loop', port, taskId] as const;
}
export function taskVerificationKey(
  port: number | undefined,
  taskId: string | undefined
) {
  return [ORCHESTRATION_QUERY_ROOT, 'verification', port, taskId] as const;
}
function epicLedgerKey(port: number | undefined, epicId: string | undefined) {
  return [ORCHESTRATION_QUERY_ROOT, 'ledger', port, epicId] as const;
}
/** The project-wide bucket (`epicId: null`), kept under the same 'ledger' root
 *  so `ledger.changed` invalidates it alongside every epic's. */
function projectLedgerKey(port: number | undefined) {
  return [ORCHESTRATION_QUERY_ROOT, 'ledger', port, null] as const;
}
export function findingsQueryRootKey(port: number | undefined) {
  return [ORCHESTRATION_QUERY_ROOT, 'findings', port] as const;
}
/** Prefix of every fix-loop key — per-task and the bulk list — so one
 *  `fixloop.changed` invalidation refreshes them all. */
export function fixLoopQueryRootKey(port: number | undefined) {
  return [ORCHESTRATION_QUERY_ROOT, 'fix-loop', port] as const;
}
function fixLoopsBulkKey(port: number | undefined) {
  return [ORCHESTRATION_QUERY_ROOT, 'fix-loop', port, '__all__'] as const;
}
export function ledgerQueryRootKey(port: number | undefined) {
  return [ORCHESTRATION_QUERY_ROOT, 'ledger', port] as const;
}

// True only for "nothing yet" (no loop opened, no verify result) — any other
// status is a real failure and must not be read as empty data.
function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/** A task's findings, for the findings panel. Check `error` before reading
 *  an empty `findings` as "nothing open" — see `useFixLoop`. */
export function useTaskFindings(
  client: ApiClient | null,
  port: number | undefined,
  taskId: string | undefined
) {
  const { data, isLoading, error } = useQuery({
    queryKey: taskFindingsKey(port, taskId),
    queryFn: () => {
      if (client === null || taskId === undefined) {
        throw new Error('dispatchd client not ready');
      }
      return client.fetchTaskFindings(taskId);
    },
    enabled: client !== null && taskId !== undefined,
    retry: false,
  });
  return {
    findings: data ?? [],
    loading: isLoading,
    error: error instanceof Error ? error.message : null,
  };
}

/**
 * What agent reviews of a GitHub PR found.
 *
 * Its own hook rather than `useTaskFindings`: a PR review's task is
 * synthesized server-side and no client ever holds its id. Keyed under the
 * same 'findings' root, so `finding.changed` — which carries no id and
 * invalidates the whole root — refreshes this the moment a review ends.
 *
 * `error` is returned, not swallowed: the panel renders an empty list as
 * nothing at all (an empty set means no review ran, and saying otherwise
 * would read as a clean bill of health), so a failed fetch would otherwise
 * be indistinguishable from the one state that is deliberately silent.
 */
export function usePrFindings(
  client: ApiClient | null,
  port: number | undefined,
  number: number | null
) {
  const { data, error } = useQuery({
    queryKey: [
      ORCHESTRATION_QUERY_ROOT,
      'findings',
      port,
      number === null ? null : `pr-${number}`,
    ] as const,
    queryFn: () => {
      if (client === null || number === null) {
        throw new Error('dispatchd client not ready');
      }
      return client.fetchPrFindings(number);
    },
    enabled: client !== null && number !== null,
    retry: false,
  });
  return {
    findings: data ?? [],
    error: error instanceof Error ? error.message : null,
  };
}

/** A task's fix-loop state: `null` means no loop opened; `error` means the
 *  fetch failed — the two must not read as the same empty state. */
export function useFixLoop(
  client: ApiClient | null,
  port: number | undefined,
  taskId: string | undefined
) {
  const { data, isLoading, error } = useQuery({
    queryKey: fixLoopKey(port, taskId),
    queryFn: async () => {
      if (client === null || taskId === undefined) {
        throw new Error('dispatchd client not ready');
      }
      try {
        return await client.fetchFixLoop(taskId);
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    enabled: client !== null && taskId !== undefined,
    retry: false,
  });
  return {
    fixLoop: data ?? null,
    loading: isLoading,
    error: error instanceof Error ? error.message : null,
  };
}

/** Every task's fix-loop state as a by-task map — the bulk read a feed
 *  annotates rows from, one request instead of one per task. Refreshed by the
 *  same `fixloop.changed` invalidation as the per-task query (shared root). */
export function useFixLoops(
  client: ApiClient | null,
  port: number | undefined
): ReadonlyMap<string, FixLoopState> {
  const { data } = useQuery({
    queryKey: fixLoopsBulkKey(port),
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchFixLoops();
    },
    enabled: client !== null,
    retry: false,
  });
  return useMemo(
    () => new Map((data ?? []).map((state) => [state.taskId, state])),
    [data]
  );
}

/** The Stop button: caps a task's loop where it stands. `useStartFixLoop`'s
 *  button doubles as Resume afterwards. */
export function useStopFixLoop(
  client: ApiClient | null,
  port: number | undefined
) {
  const queryClient = useQueryClient();
  return useCallback(
    async (taskId: string): Promise<FixLoopState> => {
      if (client === null) throw new Error('dispatchd client not ready');
      const state = await client.stopFixLoop(taskId);
      void queryClient.invalidateQueries({
        queryKey: fixLoopQueryRootKey(port),
      });
      return state;
    },
    [client, queryClient, port]
  );
}

/** Opens the review -> fix loop for a task, or advances an already-open one —
 *  the task view's "Review & fix" button. Auto-ignition is off by default
 *  (`fixLoop.auto`), so this is normally what starts a loop at all. */
export function useStartFixLoop(
  client: ApiClient | null,
  port: number | undefined
) {
  const queryClient = useQueryClient();
  return useCallback(
    async (taskId: string): Promise<FixLoopState> => {
      if (client === null) throw new Error('dispatchd client not ready');
      const state = await client.startFixLoop(taskId);
      void queryClient.invalidateQueries({
        queryKey: fixLoopKey(port, taskId),
      });
      void queryClient.invalidateQueries({
        queryKey: taskFindingsKey(port, taskId),
      });
      return state;
    },
    [client, queryClient, port]
  );
}

/** A task's latest verify result — same null/error split as `useFixLoop`. */
export function useTaskVerification(
  client: ApiClient | null,
  port: number | undefined,
  taskId: string | undefined
) {
  const { data, isLoading, error } = useQuery({
    queryKey: taskVerificationKey(port, taskId),
    queryFn: async () => {
      if (client === null || taskId === undefined) {
        throw new Error('dispatchd client not ready');
      }
      try {
        return await client.fetchTaskVerification(taskId);
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    enabled: client !== null && taskId !== undefined,
    retry: false,
  });
  return {
    result: data ?? null,
    loading: isLoading,
    error: error instanceof Error ? error.message : null,
  };
}

/** An epic's ledger — findings/decisions carried forward to its tasks.
 *  `error` must be checked the same way as `useTaskFindings`'s. */
export function useEpicLedger(
  client: ApiClient | null,
  port: number | undefined,
  epicId: string | undefined
) {
  const { data, isLoading, error } = useQuery({
    queryKey: epicLedgerKey(port, epicId),
    queryFn: () => {
      if (client === null || epicId === undefined) {
        throw new Error('dispatchd client not ready');
      }
      return client.fetchLedger({ epicId });
    },
    enabled: client !== null && epicId !== undefined,
    retry: false,
  });
  return {
    entries: data ?? [],
    loading: isLoading,
    error: error instanceof Error ? error.message : null,
  };
}

/** The project-wide ledger — entries filed with no epic, which is where a
 *  scope grant on a parentless task lands. */
export function useProjectLedger(
  client: ApiClient | null,
  port: number | undefined,
  enabled: boolean
) {
  const { data, isLoading, error } = useQuery({
    queryKey: projectLedgerKey(port),
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchLedger({ epicId: null });
    },
    enabled: client !== null && enabled,
    retry: false,
  });
  return {
    entries: data ?? [],
    loading: isLoading,
    error: error instanceof Error ? error.message : null,
  };
}

/** Rules on an open finding — the one write this surface needs, since a
 *  capped loop only moves once every open finding has a ruling. */
export function useAdjudicateFinding(
  client: ApiClient | null,
  port: number | undefined
) {
  const queryClient = useQueryClient();
  return useCallback(
    async (
      taskId: string,
      findingId: string,
      input: AdjudicateFindingInput
    ): Promise<AdjudicateFindingResult> => {
      if (client === null) throw new Error('dispatchd client not ready');
      const result = await client.adjudicateFinding(taskId, findingId, input);
      void queryClient.invalidateQueries({
        queryKey: taskFindingsKey(port, taskId),
      });
      void queryClient.invalidateQueries({
        queryKey: fixLoopKey(port, taskId),
      });
      return result;
    },
    [client, queryClient, port]
  );
}
