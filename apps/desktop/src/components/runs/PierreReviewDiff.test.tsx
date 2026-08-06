import { ApiError } from '@dispatch/client';
import type { FileDiffMetadata } from '@pierre/diffs';
import { describe, expect, it } from 'bun:test';

import {
  buildItems,
  editErrorMessage,
  resolveEditFailure,
} from '@/lib/reviewDiffItems';

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
  it('a viewed file still collapses while its edit mode is gated off (nothing loaded yet)', () => {
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

describe('buildItems — collapsed and edit are never both true for the same item', () => {
  // Pierre's own doc comment for `edit` says it is "ignored while `collapsed` is true". A
  // reviewer who ticked a file "viewed" (which sets `collapsed: true`) could still click its
  // pencil: the load gate resolves, `editing`/`loaded` line up, and without this override
  // `buildItems` would emit `{ edit: true, collapsed: true }` — Pierre never attaches an
  // editor for it, but the one-file-at-a-time lock is still engaged (every other pencil
  // hidden, this file's gutter "+" suppressed), with no escape but re-clicking the same
  // pencil. Entering edit mode must force the file open.
  it('un-collapses the file once it actually enters edit mode, even if marked viewed', () => {
    const items = buildItems({
      files: [fileDiff('a.ts')],
      editing: 'a.ts',
      loaded: new Set(['a.ts']),
      viewed: new Set(['a.ts']),
    });

    expect(items[0]?.edit).toBe(true);
    expect(items[0]?.collapsed).toBe(false);
  });

  it('leaves a different viewed file collapsed while another file is being edited', () => {
    const items = buildItems({
      files: [fileDiff('a.ts'), fileDiff('b.ts')],
      editing: 'a.ts',
      loaded: new Set(['a.ts', 'b.ts']),
      viewed: new Set(['a.ts', 'b.ts']),
    });

    const a = items.find((i) => i.id === 'a.ts');
    const b = items.find((i) => i.id === 'b.ts');
    expect(a?.edit).toBe(true);
    expect(a?.collapsed).toBe(false);
    // `b.ts` is loaded too, but it isn't the file being edited — it stays exactly as `viewed`
    // says, collapsed and not editable.
    expect(b?.edit).toBe(false);
    expect(b?.collapsed).toBe(true);
  });

  it('re-collapses a viewed file once editing moves elsewhere', () => {
    const items = buildItems({
      files: [fileDiff('a.ts')],
      editing: 'b.ts',
      loaded: new Set(['a.ts', 'b.ts']),
      viewed: new Set(['a.ts']),
    });

    expect(items[0]?.edit).toBe(false);
    expect(items[0]?.collapsed).toBe(true);
  });
});

describe('editErrorMessage — maps applyRunEdit failures to reviewer-facing sentences', () => {
  // `PierreReviewDiff` always closes the editor on any save failure (see `resolveEditFailure`
  // below) — these two sentences say so explicitly rather than implying the draft survived,
  // which the earlier wording ("wait for it to finish") did not contradict but also did
  // nothing to correct while the UI kept the editor open on top of a promise it couldn't
  // keep.
  it('maps worktree-busy, and says the edit was not saved', () => {
    expect(editErrorMessage(new ApiError('worktree-busy', 409))).toBe(
      'An agent is working in this worktree, so this edit was not saved — wait for it to finish, then reopen the file and redo it.'
    );
  });

  it('maps stale-base, and says the edit was not saved', () => {
    expect(editErrorMessage(new ApiError('stale-base', 409))).toBe(
      'This file changed while you were editing, so this edit was not saved. Reload the diff to see the new version.'
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

describe('resolveEditFailure — what happens to state after a save fails', () => {
  // Fix round 1 finding: an earlier version re-opened the editor (`editing` back to the
  // file) on `worktree-busy`/`stale-base`, believing that kept the reviewer's draft safe.
  // It did not — `onItemEditComplete` fires only once Pierre has already torn the editor
  // down, and re-attaching it has no documented way to seed the reviewer's unsaved text, so
  // the "recovered" editor actually showed stale on-disk content while the banner claimed
  // their work was fine. `editing` must always end up `null`: closing honestly, never
  // reopening on a promise Pierre can't keep.
  it('always closes the editor, whatever the failure', () => {
    expect(resolveEditFailure(new ApiError('worktree-busy', 409)).editing).toBe(
      null
    );
    expect(resolveEditFailure(new ApiError('stale-base', 409)).editing).toBe(
      null
    );
    expect(
      resolveEditFailure(new ApiError('worktree-missing', 409)).editing
    ).toBe(null);
    expect(
      resolveEditFailure(new ApiError('empty-contents', 409)).editing
    ).toBe(null);
    expect(resolveEditFailure(new Error('network down')).editing).toBe(null);
  });

  it('asks for the cache to be evicted only on stale-base, where disk actually changed', () => {
    expect(
      resolveEditFailure(new ApiError('stale-base', 409)).refetchContents
    ).toBe(true);
  });

  it('does not ask for eviction on failures where disk never changed', () => {
    expect(
      resolveEditFailure(new ApiError('worktree-busy', 409)).refetchContents
    ).toBe(false);
    expect(
      resolveEditFailure(new ApiError('worktree-missing', 409)).refetchContents
    ).toBe(false);
    expect(
      resolveEditFailure(new ApiError('empty-contents', 409)).refetchContents
    ).toBe(false);
    expect(resolveEditFailure(new Error('network down')).refetchContents).toBe(
      false
    );
  });
});
