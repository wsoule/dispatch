import type { ApiClient } from '@dispatch/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import type {
  AdjudicateFindingInput,
  AdjudicateFindingResult,
} from '../lib/apiTypes';

// Shared root so a broad `finding.changed`/`ledger.changed` event (neither
// carries an id) can invalidate every open query of that kind in one call.
const ORCHESTRATION_QUERY_ROOT = 'dispatch-orchestration';

export function taskFindingsKey(taskId: string | undefined) {
  return [ORCHESTRATION_QUERY_ROOT, 'findings', taskId] as const;
}
export function fixLoopKey(taskId: string | undefined) {
  return [ORCHESTRATION_QUERY_ROOT, 'fix-loop', taskId] as const;
}
export function taskVerificationKey(taskId: string | undefined) {
  return [ORCHESTRATION_QUERY_ROOT, 'verification', taskId] as const;
}
export function epicLedgerKey(epicId: string | undefined) {
  return [ORCHESTRATION_QUERY_ROOT, 'ledger', epicId] as const;
}
export const findingsQueryRootKey = [
  ORCHESTRATION_QUERY_ROOT,
  'findings',
] as const;
export const ledgerQueryRootKey = [ORCHESTRATION_QUERY_ROOT, 'ledger'] as const;

/** A task's findings, for the detail dialog's findings panel. */
export function useTaskFindings(
  client: ApiClient | null,
  taskId: string | undefined
) {
  const { data, isLoading } = useQuery({
    queryKey: taskFindingsKey(taskId),
    queryFn: () => {
      if (client === null || taskId === undefined) {
        throw new Error('dispatchd client not ready');
      }
      return client.fetchTaskFindings(taskId);
    },
    enabled: client !== null && taskId !== undefined,
  });
  return { findings: data ?? [], loading: isLoading };
}

/** A task's fix-loop state, or `null` when the loop has never opened — a 404
 *  from the server, which this treats as data rather than an error banner. */
export function useFixLoop(
  client: ApiClient | null,
  taskId: string | undefined
) {
  const { data, isLoading, isError } = useQuery({
    queryKey: fixLoopKey(taskId),
    queryFn: () => {
      if (client === null || taskId === undefined) {
        throw new Error('dispatchd client not ready');
      }
      return client.fetchFixLoop(taskId);
    },
    enabled: client !== null && taskId !== undefined,
    retry: false,
  });
  return { fixLoop: isError ? null : (data ?? null), loading: isLoading };
}

/** A task's latest verify-run result, or `null` when none has ever produced
 *  one — same 404-as-data treatment as `useFixLoop`. */
export function useTaskVerification(
  client: ApiClient | null,
  taskId: string | undefined
) {
  const { data, isLoading, isError } = useQuery({
    queryKey: taskVerificationKey(taskId),
    queryFn: () => {
      if (client === null || taskId === undefined) {
        throw new Error('dispatchd client not ready');
      }
      return client.fetchTaskVerification(taskId);
    },
    enabled: client !== null && taskId !== undefined,
    retry: false,
  });
  return { result: isError ? null : (data ?? null), loading: isLoading };
}

/** An epic's ledger — findings/decisions carried forward to its tasks. */
export function useEpicLedger(
  client: ApiClient | null,
  epicId: string | undefined
) {
  const { data, isLoading } = useQuery({
    queryKey: epicLedgerKey(epicId),
    queryFn: () => {
      if (client === null || epicId === undefined) {
        throw new Error('dispatchd client not ready');
      }
      return client.fetchLedger({ epicId });
    },
    enabled: client !== null && epicId !== undefined,
  });
  return { entries: data ?? [], loading: isLoading };
}

/** Rules on an open finding — the one write this surface needs, since a
 *  capped loop only moves once every open finding has a ruling. */
export function useAdjudicateFinding(client: ApiClient | null) {
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
        queryKey: taskFindingsKey(taskId),
      });
      void queryClient.invalidateQueries({ queryKey: fixLoopKey(taskId) });
      return result;
    },
    [client, queryClient]
  );
}
