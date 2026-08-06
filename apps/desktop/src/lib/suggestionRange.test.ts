import { ApiError } from '@dispatch/client';
import { describe, expect, it } from 'bun:test';

import {
  resolveApplySuggestionFailure,
  seedFromRange,
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
      'The code here has changed since this suggestion was written, so it can no longer be applied by line number.'
    );
  });

  it('does not disable on worktree-busy, a transient condition', () => {
    const outcome = resolveApplySuggestionFailure(
      new ApiError('worktree-busy', 409)
    );
    expect(outcome.disable).toBe(false);
    expect(outcome.message).toBe(
      'An agent is working in this worktree — wait for it to finish, then try again.'
    );
  });

  it('does not disable on worktree-missing', () => {
    const outcome = resolveApplySuggestionFailure(
      new ApiError('worktree-missing', 409)
    );
    expect(outcome.disable).toBe(false);
    expect(outcome.message).toBe("This run's worktree is gone.");
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
