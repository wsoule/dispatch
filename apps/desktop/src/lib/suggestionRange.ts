import { ApiError } from '@dispatch/client';

/** The text a suggestion editor starts from: lines `startLine..endLine`, inclusive
 *  and 1-based, clamped to the file so a stale range cannot read past the end. */
export function seedFromRange(
  contents: string,
  startLine: number,
  endLine: number
): string {
  const lines = contents.replace(/\n$/, '').split('\n');
  return lines
    .slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine))
    .join('\n');
}

/**
 * What to submit as a comment's `suggestion` field. Compared by exact string, not trimmed — a
 * suggestion is code, and whitespace-only edits (reindenting, say) are real changes the agent
 * needs to see. An editor whose text still equals the seed means the reviewer never actually
 * proposed a replacement, so this is a prose comment rather than a suggestion.
 */
export function suggestionForSubmit(
  seed: string,
  edited: string
): string | undefined {
  return edited === seed ? undefined : edited;
}

/** What a failed `applySuggestion` call means for the thread's Apply button. */
export interface ApplySuggestionOutcome {
  /** Reviewer-facing sentence explaining the failure. */
  message: string;
  /**
   * True for the failures where retrying the exact same request can only fail the same way:
   * the anchored code has moved, or the run has been reviewed and its branch is closed. A busy
   * or missing worktree is transient or environmental, so the button stays clickable.
   */
  disable: boolean;
}

// Failures no retry can clear — see `ApplySuggestionOutcome.disable`.
const PERMANENT_APPLY_FAILURES = new Set(['anchor-drifted', 'run-reviewed']);

/**
 * The server's machine-readable `applySuggestion` 409 codes, mirrored from
 * `packages/server/src/api.ts`'s `applySuggestion`. Kept separate from `EDIT_ERROR_MESSAGES` in
 * `reviewDiffItems.ts` — that map is `applyRunEdit`'s own codes (`stale-base`, `empty-contents`)
 * which `applySuggestion` never returns, and vice versa (`anchor-drifted` is unique to this path).
 */
const APPLY_SUGGESTION_ERROR_MESSAGES: Record<string, string> = {
  'anchor-drifted':
    "The code changed since this suggestion. It can't be applied anymore.",
  'worktree-busy': 'An agent is working here. Wait for it to finish.',
  'worktree-missing': "This run's worktree is gone.",
  'run-reviewed':
    'This run has already been reviewed, so its branch is closed to further edits.',
};

/**
 * Turns a failed `applySuggestion` call into the sentence the reviewer sees, and decides whether
 * retrying could ever succeed. Pulled out of `ReviewThread` so the disable decision is
 * unit-testable without rendering the thread.
 */
export function resolveApplySuggestionFailure(
  error: unknown
): ApplySuggestionOutcome {
  if (error instanceof ApiError && error.status === 409) {
    return {
      message:
        APPLY_SUGGESTION_ERROR_MESSAGES[error.message] ??
        'Could not apply this suggestion.',
      disable: PERMANENT_APPLY_FAILURES.has(error.message),
    };
  }
  return { message: 'Could not apply this suggestion.', disable: false };
}

/**
 * Whether the composer's `Apply now` button has anything to do: a real edit (not just the
 * unchanged seed — see `suggestionForSubmit`) AND somewhere to apply it (the caller passes
 * whether an `onApply` function was actually supplied, mirroring how `ReviewThread`'s own Apply
 * button is withheld rather than shown disabled when there is no run to apply into).
 */
export function canApplyNow(
  seed: string,
  edited: string,
  hasApplyTarget: boolean
): boolean {
  return hasApplyTarget && suggestionForSubmit(seed, edited) !== undefined;
}

/**
 * `Apply now`'s save-then-apply orchestration: save the comment, then immediately apply its
 * suggestion through the exact same `apply` function `ReviewThread`'s own Apply button uses
 * (callers pass that bound function in, including its `invalidate` call — this never
 * duplicates that logic).
 *
 * A failed apply must never look like a failed save or undo one: it is only *reported* via
 * `onApplyNowFailed`, never rethrown, and this always resolves with the comment `save` produced
 * so the commit stays retryable from the thread's own Apply button. It does reject when `save`
 * itself fails, since then there is nothing to apply.
 *
 * Lives here rather than inline in `ReviewComposer` so the ordering is unit-testable: driving
 * Pierre's real editor to produce a changed suggestion is not possible under `bun test`.
 */
export async function submitAndApplyNow<T extends { id: string }>(
  save: () => Promise<T>,
  apply: (commentId: string) => Promise<void>,
  onApplyNowFailed: (commentId: string, outcome: ApplySuggestionOutcome) => void
): Promise<T> {
  const created = await save();
  try {
    await apply(created.id);
  } catch (err) {
    onApplyNowFailed(created.id, resolveApplySuggestionFailure(err));
  }
  return created;
}
