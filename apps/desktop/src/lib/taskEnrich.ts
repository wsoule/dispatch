import type { PlanRecord } from '@dispatch/client';
import type { UpdatePatch } from '@dispatch/core/browser';

/** The sections an "Add detail" pass proposes for a task that already exists. */
export interface TaskEnrichDraft {
  description: string;
  acceptanceCriteria: string[];
}

/**
 * The draft an enrich plan is carrying, or `null` when there's nothing to review yet. Reads
 * only the first task: the prompt asks for exactly one, and this deepens a task rather than
 * fanning it out.
 */
export function enrichDraftFromPlan(
  record: PlanRecord | undefined
): TaskEnrichDraft | null {
  if (record === undefined || record.state !== 'ready') return null;
  const task = record.proposal?.tasks[0];
  if (task === undefined) return null;
  const draft: TaskEnrichDraft = {
    description: task.description.trim(),
    acceptanceCriteria: task.acceptanceCriteria
      .map((c) => c.trim())
      .filter((c) => c !== ''),
  };
  // Neither section filled in means there's nothing worth showing a review panel for.
  if (draft.description === '' && draft.acceptanceCriteria.length === 0) {
    return null;
  }
  return draft;
}

/**
 * Why an enrich pass ended with nothing to review, or `null` while running / when a draft is
 * waiting. A `ready` plan with an empty proposal counts: silence would read as a dead button.
 */
export function enrichPlanError(record: PlanRecord | undefined): string | null {
  if (record === undefined || record.state === 'running') return null;
  if (record.state === 'failed') {
    return record.error ?? 'the planner failed to draft any detail';
  }
  // Waiting on the user is not a failure — the questions form renders instead.
  if (record.questions.length > 0) return null;
  if (enrichDraftFromPlan(record) === null) {
    return 'the planner came back with nothing to add';
  }
  return null;
}

/**
 * Maps an accepted draft onto the task store's whole-section `UpdatePatch`. An empty section
 * is omitted, never sent as `''` — that would wipe text a human wrote there.
 */
export function enrichPatch(draft: TaskEnrichDraft): UpdatePatch {
  const patch: UpdatePatch = {};
  if (draft.description !== '') patch.description = draft.description;
  if (draft.acceptanceCriteria.length > 0) {
    patch.acceptanceCriteria = draft.acceptanceCriteria
      .map((c) => `- ${c}`)
      .join('\n');
  }
  return patch;
}
