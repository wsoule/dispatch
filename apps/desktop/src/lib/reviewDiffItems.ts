import { ApiError } from '@dispatch/client';
import type { Finding, ReviewComment } from '@dispatch/client';
import type {
  CodeViewDiffItem,
  DiffLineAnnotation,
  FileDiffMetadata,
} from '@pierre/diffs';

/** What each annotation carries, so `PierreReviewDiff`'s `renderAnnotation` knows what to draw. */
export type Annotation =
  | { kind: 'threads'; file: string; comments: ReviewComment[] }
  | { kind: 'findings'; file: string; findings: Finding[] }
  | {
      kind: 'composer';
      file: string;
      anchorText: string;
      startLine?: number;
    };

export interface BuildItemsInput {
  files: FileDiffMetadata[];
  comments?: ReviewComment[];
  findings?: Finding[];
  composing?: {
    file: string;
    line: number;
    startLine?: number;
    anchorText: string;
  } | null;
  /** Files the reviewer has ticked off — rendered collapsed. */
  viewed?: ReadonlySet<string>;
  /** The one file currently in edit mode, or `null`. Only one file is ever editable at a
   * time — see the module doc comment on `buildItems`. */
  editing: string | null;
  /** Files whose contents have resolved via `useRunFileLoader`'s `ensureLoaded`. Gates `edit`
   * below — see the module doc comment on `buildItems`. */
  loaded: ReadonlySet<string>;
}

/**
 * Builds Pierre's per-file `CodeViewDiffItem`s from the parsed patch plus review state layered
 * on top: comment threads, agent findings, an open composer, viewed/collapsed state, and edit
 * mode.
 *
 * Deliberately pulled out of `PierreReviewDiff`'s `useMemo` and into its own module (rather than
 * just exported from the component file) — the component's module graph pulls in
 * `PierreWorkerPool`, which imports `@pierre/diffs/worker/worker.js?worker&url`, a Vite-only
 * import specifier `bun test` cannot resolve at all. Importing anything from the component file,
 * even a single named export, would still evaluate that whole chain. This module has no such
 * import, so the load gate below is unit-testable without a DOM.
 *
 * **The load gate**: `edit` only becomes `true` once `loaded` says the file's contents have
 * actually resolved (`editing === id && loaded.has(id)`), never from `editing` alone. A headless
 * spike of `@pierre/diffs` proved that setting `edit: true` on an item whose contents have not
 * loaded yet still attaches an editor — but that editor's document is empty (`getText()` returns
 * `''`). Saving that would silently overwrite the agent's work with nothing, so `edit` must never
 * turn on before contents are confirmed in hand. `loadDiffFiles` (the contents loader Pierre
 * calls to expand hunks) is lazy and makes no calls until a file first needs them, so `editing`
 * alone can be set well before any contents exist for that file.
 *
 * Pierre requires bumping an item's `version` whenever its `edit` flag changes, or it silently
 * keeps rendering the previous (non-edit) view — see the `edit` field's own doc comment in
 * `CodeViewDiffItem`. `edit ? 1 : 0` is enough: `edit` only has two states, so any transition
 * between them is always a version change too.
 */
export function buildItems({
  files,
  comments = [],
  findings = [],
  composing = null,
  viewed,
  editing,
  loaded,
}: BuildItemsInput): CodeViewDiffItem<Annotation>[] {
  return files.map((fileDiff) => {
    const annotations: DiffLineAnnotation<Annotation>[] = [];

    // Existing threads, grouped so several comments on one line render as one stack rather
    // than several separately-positioned annotations fighting for the same row.
    const byLine = new Map<number, ReviewComment[]>();
    for (const c of comments) {
      if (c.file !== fileDiff.name) continue;
      const bucket = byLine.get(c.line);
      if (bucket === undefined) byLine.set(c.line, [c]);
      else bucket.push(c);
    }
    for (const [line, list] of byLine) {
      annotations.push({
        side: 'additions',
        lineNumber: line,
        metadata: { kind: 'threads', file: fileDiff.name, comments: list },
      });
    }

    // The agent review's findings, anchored the same way threads are. A finding with no line
    // has nothing to point at here and belongs to the case panel instead.
    const findingsByLine = new Map<number, Finding[]>();
    for (const f of findings) {
      if (f.file !== fileDiff.name || f.line === null) continue;
      const bucket = findingsByLine.get(f.line);
      if (bucket === undefined) findingsByLine.set(f.line, [f]);
      else bucket.push(f);
    }
    for (const [line, list] of findingsByLine) {
      annotations.push({
        side: 'additions',
        lineNumber: line,
        metadata: { kind: 'findings', file: fileDiff.name, findings: list },
      });
    }

    if (composing !== null && composing.file === fileDiff.name) {
      annotations.push({
        side: 'additions',
        lineNumber: composing.line,
        metadata: {
          kind: 'composer',
          file: composing.file,
          anchorText: composing.anchorText,
          ...(composing.startLine !== undefined
            ? { startLine: composing.startLine }
            : {}),
        },
      });
    }

    const edit = editing === fileDiff.name && loaded.has(fileDiff.name);

    return {
      id: fileDiff.name,
      type: 'diff',
      fileDiff,
      annotations,
      // A file you have ticked off collapses, so a long review visibly shrinks as you work
      // through it rather than staying the same size forever — EXCEPT the file actually
      // entering edit mode right now, which is force-expanded regardless of `viewed`.
      // Pierre's own doc comment for `edit` says it is "ignored while `collapsed` is true";
      // without this override, clicking the pencil on a file the reviewer had ticked viewed
      // would resolve the load gate and set `edit: true` while `collapsed` stayed `true` too
      // — Pierre never attaches an editor for it, but the one-file-at-a-time lock (every
      // other pencil hidden, this file's gutter "+" suppressed) is still engaged, with no
      // escape but re-clicking the same pencil.
      collapsed: edit ? false : (viewed?.has(fileDiff.name) ?? false),
      edit,
      version: edit ? 1 : 0,
    };
  });
}

/**
 * The server's machine-readable `applyRunEdit` 409 codes, each with a different fix — see
 * `packages/server/src/api.ts`'s `applyRunEdit`.
 *
 * `worktree-busy` and `stale-base` say outright that the edit was not saved. `PierreReviewDiff`
 * always closes the editor on any failure (see `resolveEditFailure`) — an earlier version left
 * it open for these two, believing that preserved the reviewer's draft, but Pierre tears the
 * editor down before this message is ever shown and there is no way to seed a freshly attached
 * editor with unsaved text. Saying nothing about that would have let the old "keep it open" UI
 * imply the draft survived when it didn't; these sentences say what actually happened instead.
 */
const EDIT_ERROR_MESSAGES: Record<string, string> = {
  'worktree-busy':
    'An agent is working in this worktree, so this edit was not saved — wait for it to finish, then reopen the file and redo it.',
  'stale-base':
    'This file changed while you were editing, so this edit was not saved. Reload the diff to see the new version.',
  'worktree-missing': "This run's worktree is gone.",
  'empty-contents': "Couldn't read this file — nothing was written.",
};

/**
 * Turns a failed `applyRunEdit` call into the sentence the reviewer sees. Each 409's `error`
 * string names a different failure with a different fix, so this maps them one at a time rather
 * than showing one generic "save failed" for all of them.
 */
export function editErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return EDIT_ERROR_MESSAGES[error.message] ?? 'Could not save this edit.';
  }
  return 'Could not save this edit.';
}

/** What `PierreReviewDiff`'s `handleEditComplete` should do to its own state after a failed
 * `applyRunEdit`. */
export interface EditFailureOutcome {
  /**
   * Always `null`. `onItemEditComplete` fires only once Pierre has already torn the editor
   * down (its own doc comment: "when an item's edit session ends"), and there is no
   * documented way to seed a freshly attached editor with the reviewer's unsaved draft. An
   * earlier version set `editing` back to the file on a "recoverable" 409, intending to keep
   * the draft alive — but `editing` going `false` then `true` across renders is exactly what
   * tears the old editor down and attaches a new one seeded from on-disk (or cached) content,
   * so the draft was lost regardless, while the shown message implied otherwise. Closing
   * unconditionally means the UI never promises more than Pierre can actually deliver.
   */
  editing: null;
  /**
   * `true` only for `stale-base` — the one failure where the file's on-disk content genuinely
   * changed while the reviewer was editing, which makes both the loader's cached contents/sha
   * and this component's own `loaded` marker wrong. Evicting them means the reviewer's next
   * look at the file (via a fresh pencil click) fetches the real current content rather than
   * the now-stale cached copy. The other three failures never touched disk, so their cached
   * entries are still correct and evicting them would just cost an unnecessary refetch.
   */
  refetchContents: boolean;
}

/**
 * Decides what a failed `applyRunEdit` means for `editing`/cache state — pulled out of the
 * component so the "never re-open the editor on a false promise" behaviour (see
 * `EditFailureOutcome.editing`'s doc comment) is unit-testable without rendering `CodeView`.
 */
export function resolveEditFailure(error: unknown): EditFailureOutcome {
  return {
    editing: null,
    refetchContents:
      error instanceof ApiError &&
      error.status === 409 &&
      error.message === 'stale-base',
  };
}
