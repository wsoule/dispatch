import type { PlanRecord } from '@dispatch/client';

/** The sections an "Add detail" pass proposes — the same shape whether the target is an
 * existing task (`taskEnrich.ts`'s `TaskEnrichDraft`) or a raw inbox capture, since both
 * proposals come back through the same planner output (`PlannedTask` in `@dispatch/client`). */
export interface EnrichDraft {
  description: string;
  acceptanceCriteria: string[];
}

export type EnrichViewState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ready'; draft: EnrichDraft }
  | { kind: 'failed'; error: string };

/**
 * Maps a polled plan record onto what a review panel should show. Reads only the first task
 * the planner proposed — the enrich prompts all ask for exactly one — and folds "ready but the
 * proposal has nothing usable" into `failed`, since silence there would read as a dead button
 * rather than a pass that genuinely found nothing to add.
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

/**
 * Flattens a draft into the single free-text body an inbox item's `text` field holds — the
 * same "description, blank line, `Acceptance criteria:` bullet block" convention
 * `taskDraftToCreateInput` (packages/client/src/api.ts) already uses to fold a structured
 * draft into one text field.
 */
export function formatEnrichedInboxText(draft: EnrichDraft): string {
  const parts = [draft.description];
  if (draft.acceptanceCriteria.length > 0) {
    parts.push(
      'Acceptance criteria:',
      draft.acceptanceCriteria.map((c) => `- ${c}`).join('\n')
    );
  }
  return parts.filter((p) => p !== '').join('\n\n');
}
