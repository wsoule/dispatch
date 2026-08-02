import type {
  AdjudicateFindingInput,
  AdjudicateFindingResult,
  ApiClient,
} from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

// Shared root for invalidating a whole event kind at once — finding.changed
// and ledger.changed carry no id, so their handlers invalidate everything here.
const ORCHESTRATION_QUERY_ROOT = 'dispatch-orchestration';

// Every key below namespaces by `port`: findings/fix-loops/ledger live in
// per-worktree `.dispatch/*.jsonl` files sharing task ids across worktrees.
export function taskFindingsKey(
  port: number | undefined,
  taskId: string | undefined
) {
  return [ORCHESTRATION_QUERY_ROOT, 'findings', port, taskId] as const;
}
export function fixLoopKey(
  port: number | undefined,
  taskId: string | undefined
) {
  return [ORCHESTRATION_QUERY_ROOT, 'fix-loop', port, taskId] as const;
}
export function taskVerificationKey(
  port: number | undefined,
  taskId: string | undefined
) {
  return [ORCHESTRATION_QUERY_ROOT, 'verification', port, taskId] as const;
}
export function epicLedgerKey(
  port: number | undefined,
  epicId: string | undefined
) {
  return [ORCHESTRATION_QUERY_ROOT, 'ledger', port, epicId] as const;
}
export function findingsQueryRootKey(port: number | undefined) {
  return [ORCHESTRATION_QUERY_ROOT, 'findings', port] as const;
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
