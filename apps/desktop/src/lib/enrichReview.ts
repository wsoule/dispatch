import type { PlanRecord } from '@dispatch/client';

/** The sections an "Add detail" pass proposes, as read off a `PlannedTask`. Local to this
 * module — the review panel declares its own structurally identical props type. */
interface EnrichDraft {
  description: string;
  acceptanceCriteria: string[];
}

export type EnrichViewState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ready'; draft: EnrichDraft }
  | { kind: 'failed'; error: string };

/**
 * Maps a polled plan record onto what a review panel should show. Reads only
 * the first proposed task; "ready but nothing usable" folds into `failed`.
 */
export function enrichViewState(
  record: PlanRecord | undefined
): EnrichViewState {
  if (record === undefined) return { kind: 'idle' };
  if (record.state === 'running') return { kind: 'running' };
  if (record.state === 'failed') {
    return {
      kind: 'failed',
      error: record.error ?? 'the planner failed to draft any detail',
    };
  }

  const task = record.proposal?.tasks[0];
  const draft: EnrichDraft | null =
    task === undefined
      ? null
      : {
          description: task.description.trim(),
          acceptanceCriteria: task.acceptanceCriteria
            .map((c) => c.trim())
            .filter((c) => c !== ''),
        };
  if (
    draft === null ||
    (draft.description === '' && draft.acceptanceCriteria.length === 0)
  ) {
    return {
      kind: 'failed',
      error: 'the planner came back with nothing to add',
    };
  }
  return { kind: 'ready', draft };
}
