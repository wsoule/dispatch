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
   * True only for `anchor-drifted` — the one failure where retrying the exact same request
   * would fail the same way, because the code the suggestion names has moved since it was
   * written and applying by line number would edit the wrong lines. Every other failure (a
   * busy worktree, a missing one) is transient or environmental, so the button stays clickable.
   */
  disable: boolean;
}

/**
 * The server's machine-readable `applySuggestion` 409 codes, mirrored from
 * `packages/server/src/api.ts`'s `applySuggestion`. Kept separate from `EDIT_ERROR_MESSAGES` in
 * `reviewDiffItems.ts` — that map is `applyRunEdit`'s own codes (`stale-base`, `empty-contents`)
 * which `applySuggestion` never returns, and vice versa (`anchor-drifted` is unique to this path).
 */
const APPLY_SUGGESTION_ERROR_MESSAGES: Record<string, string> = {
  'anchor-drifted':
    'The code here has changed since this suggestion was written, so it can no longer be applied by line number.',
  'worktree-busy':
    'An agent is working in this worktree — wait for it to finish, then try again.',
  'worktree-missing': "This run's worktree is gone.",
};

/**
 * Turns a failed `applySuggestion` call into the sentence the reviewer sees, and decides whether
 * retrying could ever succeed. Pulled out of `ReviewThread` so the "only anchor-drifted disables"
 * decision is unit-testable without rendering the thread.
 */
export function resolveApplySuggestionFailure(
  error: unknown
): ApplySuggestionOutcome {
  if (error instanceof ApiError && error.status === 409) {
    return {
      message:
        APPLY_SUGGESTION_ERROR_MESSAGES[error.message] ??
        'Could not apply this suggestion.',
      disable: error.message === 'anchor-drifted',
    };
  }
  return { message: 'Could not apply this suggestion.', disable: false };
}
