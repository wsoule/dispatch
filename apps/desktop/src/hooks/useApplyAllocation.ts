import type { UpdatePatch } from '@dispatch-foo/core/browser';
import type { AllocationRun, ApiClient } from '@dispatch/client';
import type { AllocationPlan, Snapshot } from '@dispatch/planning';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { allocationNote, buildRunInput } from '../adapters/allocation';
import { describeError } from '../lib/actionFeedback';

// Applies the planning's allocation: gives each issue to its project's lead,
// moves it out of Backlog, comments why, then records the run issue by issue
// (POST /api/planning/allocation-runs), which My week's "New to you" reads.

export interface ApplyAllocationState {
  busy: boolean;
  apply: () => Promise<AllocationRun>;
}

export function useApplyAllocation(
  client: Pick<
    ApiClient,
    'updateTask' | 'addTaskComment' | 'recordAllocationRun'
  > | null,
  plan: AllocationPlan,
  snapshot: Snapshot
): ApplyAllocationState {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  // One issue at a time, so a refusal stops only that issue and the record
  // says which ones went through.
  const apply = useCallback(async () => {
    if (client === null) throw new Error('dispatchd client not ready');
    setBusy(true);
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
      const run = await client.recordAllocationRun(
        buildRunInput(plan, snapshot, 'applied', results)
      );
      await queryClient.invalidateQueries({ queryKey: ['allocation-runs'] });
      return run;
    } finally {
      setBusy(false);
    }
  }, [client, plan, snapshot, queryClient]);

  return { busy, apply };
}
