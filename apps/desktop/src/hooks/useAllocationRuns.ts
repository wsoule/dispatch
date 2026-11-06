import type { UpdatePatch } from '@dispatch-foo/core/browser';
import type {
  AllocationRun,
  AllocationRunSummary,
  ApiClient,
} from '@dispatch/client';
import type { AllocationPlan, Snapshot } from '@dispatch/planning';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { allocationNote, buildRunInput } from '../adapters/allocation';
import { describeError } from '../lib/actionFeedback';

// The allocation run log and the two verbs that add to it: record a dry run
// (what the plan would do, nothing changed) and apply (give each issue to its
// project's lead, move it out of Backlog, leave a comment saying why, then
// record what happened, issue by issue). The plan comes from App's planning;
// the daemon keeps the log (GET/POST /api/planning/allocation-runs).

const NO_RUNS: AllocationRunSummary[] = [];

/** The run log's query key, per daemon. */
function allocationRunsKey(port: number | undefined) {
  return ['allocation-runs', port] as const;
}

export interface AllocationRunsState {
  runs: AllocationRunSummary[];
  loading: boolean;
  error: unknown;
  /** A record or apply in flight, by verb. */
  busy: 'dry_run' | 'applied' | null;
  recordDryRun: () => Promise<AllocationRun>;
  apply: () => Promise<AllocationRun>;
}

export function useAllocationRuns(
  client: ApiClient | null,
  port: number | undefined,
  plan: AllocationPlan,
  snapshot: Snapshot
): AllocationRunsState {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<AllocationRunsState['busy']>(null);
  const q = useQuery({
    queryKey: allocationRunsKey(port),
    enabled: client !== null,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchAllocationRuns();
    },
  });

  const recorded = useCallback(
    async (run: AllocationRun) => {
      await queryClient.invalidateQueries({ queryKey: ['allocation-runs'] });
      return run;
    },
    [queryClient]
  );

  const recordDryRun = useCallback(async () => {
    if (client === null) throw new Error('dispatchd client not ready');
    setBusy('dry_run');
    try {
      return await recorded(
        await client.recordAllocationRun(
          buildRunInput(plan, snapshot, 'dry_run')
        )
      );
    } finally {
      setBusy(null);
    }
  }, [client, plan, snapshot, recorded]);

  // One issue at a time, so a refusal stops only that issue and the record
  // says which ones went through.
  const apply = useCallback(async () => {
    if (client === null) throw new Error('dispatchd client not ready');
    setBusy('applied');
    try {
      const results = new Map<string, true | string>();
      for (const project of plan.projects) {
        for (const action of project.actions) {
          const patch: UpdatePatch = { assignee: action.assigneeId };
          if (action.toStateId !== null) patch.status = action.toStateId;
          try {
            await client.updateTask(action.issueId, patch);
            results.set(action.issueId, true);
          } catch (err) {
            results.set(action.issueId, describeError(err));
            continue;
          }
          // The comment explains the change; a failed one leaves it made.
          await client
            .addTaskComment(action.issueId, {
              body: allocationNote(action, snapshot),
            })
            .catch(() => undefined);
        }
      }
      return await recorded(
        await client.recordAllocationRun(
          buildRunInput(plan, snapshot, 'applied', results)
        )
      );
    } finally {
      setBusy(null);
    }
  }, [client, plan, snapshot, recorded]);

  return {
    runs: q.data ?? NO_RUNS,
    loading: q.isLoading,
    error: q.error,
    busy,
    recordDryRun,
    apply,
  };
}
