# Bug report: edit mode can never attach to an added or deleted file diff

**Package:** `@pierre/diffs@1.3.1` **Surface:** `CodeView` (React) with
`EditProvider`, `CodeViewDiffItem.edit = true`

## Summary

A diff whose `type` is `new` or `deleted` is marked `isPartial: true` by
`processPatch`, but `canHydrateDiff` excludes those two types. The diff
therefore can never leave the partial state, `editorRenderReady()` never becomes
true, and the editor attaches without ever producing an editable surface. No
error is raised and no `__debug` output appears — the session simply stalls.

A `change` diff on the same screen, with identical options, edits normally.

## Reproduction

1. Render a `CodeView` inside an `EditProvider` whose `createEditor` returns
   `new Editor(...)`.
2. Supply two items from `processPatch`: one file with `type: 'change'` and one
   with `type: 'new'`.
3. Set `edit: true` on the `change` item (bumping `version`). An editor
   attaches; typing works.
4. Set `edit: true` on the `new` item instead. `createEditor` is called exactly
   once and `Editor.edit(instance)` runs, but no `[contenteditable="true"]`
   element is ever created and none of the `[diffs/editor] …` `__debug` lines
   are logged.

Observed in a real app against Chrome; the `change` case logs
`text document rebuilt from …`, `full re-render triggered !!!`, and
per-keystroke `re-render in: …ms (1 dirty lines)`, while the `new` case logs
nothing at all.

## Cause

Measured with `processPatch` at 1.3.1:

```text
ADDED    -> type: new    | isPartial: true
MODIFIED -> type: change | isPartial: true
```

Both are partial. But `dist/components/FileDiff.js:41`:

```js
function canHydrateDiff(fileDiff) {
  return (
    fileDiff.isPartial &&
    (fileDiff.type === 'change' ||
      fileDiff.type === 'rename-changed' ||
      fileDiff.type === 'rename-pure')
  );
}
```

`new` and `deleted` are absent. The chain that follows:

1. `FileDiff.attachEditor` (`FileDiff.js:631`) runs
   `if (this.fileDiff?.isPartial === true) this.loadFilesIfNecessary();`
2. `loadFilesIfNecessary` (`FileDiff.js:435`) returns immediately, because
   `!canHydrateDiff(fileDiff)` is true for `new`.
3. The diff stays `isPartial: true` forever — nothing else clears it.
4. `attachEditor` then checks `this.hunksRenderer.editorRenderReady()`
   (`DiffHunksRenderer.js:85`), which requires a highlighted, non-null render
   cache. It is false, so `attachEditor` falls to `this.rerender()` and never
   calls `syncRenderViewToEditor()`.
5. Nothing re-enters the editor sync afterwards, so the attached editor never
   builds a document and never marks the content element `contentEditable`.

`hydratePartialDiff` (`dist/utils/hydratePartialDiff.js`) agrees that these
types are not hydratable — it throws
`hydratePartialDiff: ${type} diffs cannot be hydrated from loaded files` for
anything outside the same three types. So the exclusion is deliberate; the gap
is that `attachEditor` has no path for a diff that is partial _and_ permanently
unhydratable.

## Why it looks like an options problem but isn't

Each of these was tested live and changed nothing, which is worth stating so the
report isn't re-litigated:

- adding a unique stable `cacheKey` to the `FileContents` returned by
  `loadDiffFiles` (with `persistState: true`)
- `useTokenTransformer: true`
- `diffStyle: 'unified'` instead of `'split'`
- `disableWorkerPool`

None of them can help, because step 2 above returns before any of them are
consulted.

## Related asymmetry, possibly the intended fix

`FileRenderer` forces the transformer on for the duration of an edit session
(`dist/renderers/FileRenderer.js:162`):

```js
useTokenTransformer: this.editSessionActive || this.options.useTokenTransformer === true,
```

`DiffHunksRenderer` has no equivalent — it reads the option with a `false`
default (`DiffHunksRenderer.js:309`). So the whole-file editing path self-heals
into a ready state during a session and the diff path does not. That may be the
cleaner place to fix this than widening `canHydrateDiff`.

## Suggested resolutions (any one would unblock)

1. Have `DiffHunksRenderer` force `useTokenTransformer` during an edit session,
   mirroring `FileRenderer`.
2. Give `attachEditor` a branch for a partial-but-unhydratable diff: an added or
   deleted file already carries every line it has, so it needs no loader — it
   could be treated as ready.
3. Stop `processPatch` marking `new`/`deleted` diffs `isPartial`, since there is
   nothing to load.

## Impact

Editing a newly added file is an ordinary code-review action, so from a
reviewer's point of view edit mode works on some files and silently does nothing
on others. The failure is invisible: the host app's own edit state engages, so
the UI can easily end up claiming the file is editable when it is not.
