import { ApiError } from '@dispatch/client';
import { describe, expect, it, mock } from 'bun:test';

import {
  canApplyNow,
  resolveApplySuggestionFailure,
  seedFromRange,
  submitAndApplyNow,
  suggestionForSubmit,
} from '@/lib/suggestionRange';

describe('seedFromRange', () => {
  it('seeds a single line', () => {
    expect(seedFromRange('a\nb\nc\n', 2, 2)).toBe('b');
  });

  it('seeds an inclusive range', () => {
    expect(seedFromRange('a\nb\nc\nd\n', 2, 3)).toBe('b\nc');
  });

  it('clamps a range that runs past the end of the file', () => {
    expect(seedFromRange('a\nb\n', 2, 9)).toBe('b');
  });

  it('seeds the whole file when the range covers it', () => {
    expect(seedFromRange('a\nb\nc\n', 1, 3)).toBe('a\nb\nc');
  });

  it('handles a file with no trailing newline the same as one with one', () => {
    expect(seedFromRange('a\nb\nc', 2, 3)).toBe('b\nc');
  });

  it('clamps a start line past the end of the file to empty', () => {
    expect(seedFromRange('a\nb\n', 5, 9)).toBe('');
  });

  it('never reads a negative start index', () => {
    expect(seedFromRange('a\nb\nc\n', 0, 1)).toBe('a');
  });
});

describe('suggestionForSubmit', () => {
  it('omits the suggestion when the editor text still matches the seed', () => {
    expect(suggestionForSubmit('b', 'b')).toBeUndefined();
  });

  it('includes the suggestion once the editor text differs from the seed', () => {
    expect(suggestionForSubmit('b', 'const b = 1;')).toBe('const b = 1;');
  });

  it('treats a whitespace-only change as a real edit — a suggestion is code', () => {
    expect(suggestionForSubmit('b', 'b ')).toBe('b ');
  });

  it('omits the suggestion when both seed and edit are empty', () => {
    expect(suggestionForSubmit('', '')).toBeUndefined();
  });
});

describe('resolveApplySuggestionFailure', () => {
  it('disables the button on anchor-drifted and says the code moved', () => {
    const outcome = resolveApplySuggestionFailure(
      new ApiError('anchor-drifted', 409)
    );
    expect(outcome.disable).toBe(true);
    expect(outcome.message).toBe(
      "The code changed since this suggestion. It can't be applied anymore."
    );
  });

  it('does not disable on worktree-busy, a transient condition', () => {
    const outcome = resolveApplySuggestionFailure(
      new ApiError('worktree-busy', 409)
    );
    expect(outcome.disable).toBe(false);
    expect(outcome.message).toBe(
      'An agent is working here. Wait for it to finish.'
    );
  });

  it('does not disable on worktree-missing', () => {
    const outcome = resolveApplySuggestionFailure(
      new ApiError('worktree-missing', 409)
    );
    expect(outcome.disable).toBe(false);
    expect(outcome.message).toBe("This run's worktree is gone.");
  });

  it('disables the button on run-reviewed, which no retry can clear', () => {
    const outcome = resolveApplySuggestionFailure(
      new ApiError('run-reviewed', 409)
    );
    expect(outcome.disable).toBe(true);
    expect(outcome.message).toBe(
      'This run has already been reviewed, so its branch is closed to further edits.'
    );
  });

  it('falls back to a generic sentence for an unrecognised 409, without disabling', () => {
    const outcome = resolveApplySuggestionFailure(
      new ApiError('something-else', 409)
    );
    expect(outcome.disable).toBe(false);
    expect(outcome.message).toBe('Could not apply this suggestion.');
  });

  it('falls back to a generic sentence for a non-ApiError failure', () => {
    const outcome = resolveApplySuggestionFailure(new Error('network down'));
    expect(outcome.disable).toBe(false);
    expect(outcome.message).toBe('Could not apply this suggestion.');
  });
});

describe('canApplyNow — whether the composer has anything for `Apply now` to do', () => {
  it('is false when the editor still matches the seed, even with somewhere to apply', () => {
    expect(canApplyNow('b', 'b', true)).toBe(false);
  });

  it('is false when the editor differs from the seed but there is nowhere to apply', () => {
    expect(canApplyNow('b', 'const b = 1;', false)).toBe(false);
  });

  it('is true only once both the edit is real and there is somewhere to apply it', () => {
    expect(canApplyNow('b', 'const b = 1;', true)).toBe(true);
  });
});

describe("submitAndApplyNow — Apply now's save-then-apply orchestration", () => {
  it('threads the id the save resolved with into apply', async () => {
    const save = () => Promise.resolve({ id: 'c-99' });
    let appliedId: string | null = null;
    const apply = (commentId: string) => {
      appliedId = commentId;
      return Promise.resolve();
    };
    await submitAndApplyNow(save, apply, () => {});
    expect(appliedId).toBe('c-99');
  });

  it('calls save before apply, never the reverse', async () => {
    const order: string[] = [];
    const save = () => {
      order.push('save');
      return Promise.resolve({ id: 'c-1' });
    };
    const apply = (commentId: string) => {
      order.push(`apply:${commentId}`);
      return Promise.resolve();
    };
    await submitAndApplyNow(save, apply, () => {});
    expect(order).toEqual(['save', 'apply:c-1']);
  });

  it('leaves the saved comment intact and reports the failure when apply rejects', async () => {
    const save = mock(() => Promise.resolve({ id: 'c-1' }));
    const apply = () => Promise.reject(new ApiError('anchor-drifted', 409));
    let reported: [string, { message: string; disable: boolean }] | null = null;
    const created = await submitAndApplyNow(
      save,
      apply,
      (commentId, outcome) => {
        reported = [commentId, outcome];
      }
    );
    // The promise resolves (does not reject) with the comment the save produced — a failed
    // apply must never look like a failed save, or the reviewer's draft would appear lost.
    expect(created).toEqual({ id: 'c-1' });
    // Save is not retried or otherwise called again just because apply failed.
    expect(save).toHaveBeenCalledTimes(1);
    expect(reported?.[0]).toBe('c-1');
    expect(reported?.[1].disable).toBe(true);
    expect(reported?.[1].message).toBe(
      "The code changed since this suggestion. It can't be applied anymore."
    );
  });

  it('propagates a save failure — there is nothing to apply and nothing to report', async () => {
    const save = () => Promise.reject(new Error('network down'));
    const apply = mock(() => Promise.resolve());
    let reportedCount = 0;
    let caught: unknown = null;
    try {
      await submitAndApplyNow(save, apply, () => {
        reportedCount += 1;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('network down');
    expect(apply).not.toHaveBeenCalled();
    expect(reportedCount).toBe(0);
  });
});
