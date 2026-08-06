import { ApiError } from '@dispatch/client';
import type { FileDiffMetadata } from '@pierre/diffs';
import { describe, expect, it } from 'bun:test';

import { buildItems, editErrorMessage } from '@/lib/reviewDiffItems';

// Minimal but type-complete `FileDiffMetadata` — mirrors the helper in
// useRunFileContents.test.ts. Only `name` varies per test; the rest are fields
// `buildItems` never reads.
function fileDiff(name: string): FileDiffMetadata {
  return {
    name,
    type: 'change',
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
  };
}

describe('buildItems — the load gate', () => {
  // The single most important test in this feature: the spike behind this task proved that
  // setting `edit: true` on an item whose contents have not resolved yet still attaches an
  // editor, but that editor's document is empty (`getText()` returns `''`). Saving that would
  // write an empty file over the agent's work, so `edit` must never turn on before `loaded`
  // says the file actually arrived.
  it('does not put a file into edit mode before its contents load', () => {
    const items = buildItems({
      files: [fileDiff('a.ts')],
      editing: 'a.ts',
      loaded: new Set(),
    });

    expect(items[0]?.edit).toBe(false);
  });

  it('puts the file into edit mode once its contents are loaded', () => {
    const items = buildItems({
      files: [fileDiff('a.ts')],
      editing: 'a.ts',
      loaded: new Set(['a.ts']),
    });

    expect(items[0]?.edit).toBe(true);
  });

  it('bumps version when edit state changes so Pierre re-renders the item', () => {
    const before = buildItems({
      files: [fileDiff('a.ts')],
      editing: null,
      loaded: new Set(['a.ts']),
    });
    const after = buildItems({
      files: [fileDiff('a.ts')],
      editing: 'a.ts',
      loaded: new Set(['a.ts']),
    });

    expect(after[0]?.version).toBeGreaterThan(before[0]?.version ?? 0);
  });

  it('only the editing file goes into edit mode among several loaded files', () => {
    const items = buildItems({
      files: [fileDiff('a.ts'), fileDiff('b.ts')],
      editing: 'a.ts',
      loaded: new Set(['a.ts', 'b.ts']),
    });

    expect(items.find((i) => i.id === 'a.ts')?.edit).toBe(true);
    expect(items.find((i) => i.id === 'b.ts')?.edit).toBe(false);
  });

  it('with editing null, no file is in edit mode regardless of what has loaded', () => {
    const items = buildItems({
      files: [fileDiff('a.ts')],
      editing: null,
      loaded: new Set(['a.ts']),
    });

    expect(items[0]?.edit).toBe(false);
  });
});

describe('buildItems — collapsed state is preserved alongside edit', () => {
  it('a viewed file still collapses even while its edit mode is gated off', () => {
    const items = buildItems({
      files: [fileDiff('a.ts')],
      editing: 'a.ts',
      loaded: new Set(),
      viewed: new Set(['a.ts']),
    });

    expect(items[0]?.collapsed).toBe(true);
    expect(items[0]?.edit).toBe(false);
  });
});

describe('editErrorMessage — maps applyRunEdit failures to reviewer-facing sentences', () => {
  it('maps worktree-busy', () => {
    expect(editErrorMessage(new ApiError('worktree-busy', 409))).toBe(
      'An agent is working in this worktree — wait for it to finish.'
    );
  });

  it('maps stale-base', () => {
    expect(editErrorMessage(new ApiError('stale-base', 409))).toBe(
      'This file changed while you were editing. Reload the diff to see the new version.'
    );
  });

  it('maps worktree-missing', () => {
    expect(editErrorMessage(new ApiError('worktree-missing', 409))).toBe(
      "This run's worktree is gone."
    );
  });

  it('maps empty-contents', () => {
    expect(editErrorMessage(new ApiError('empty-contents', 409))).toBe(
      "Couldn't read this file — nothing was written."
    );
  });

  it('falls back to a generic sentence for an unrecognised 409', () => {
    expect(editErrorMessage(new ApiError('something-else', 409))).toBe(
      'Could not save this edit.'
    );
  });

  it('falls back to a generic sentence for a non-ApiError failure', () => {
    expect(editErrorMessage(new Error('network down'))).toBe(
      'Could not save this edit.'
    );
  });
});
