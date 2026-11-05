import { ApiError } from '@dispatch/client';
import type { Finding, ReviewComment } from '@dispatch/client';
import type {
  CodeViewDiffItem,
  DiffLineAnnotation,
  FileDiffMetadata,
} from '@pierre/diffs';

/**
 * Whether an edit session can attach to a diff of this type.
 *
 * `new` and `deleted` are excluded because Pierre cannot edit them: it marks such a diff
 * `isPartial` but leaves it out of `canHydrateDiff`, so the diff stays partial forever and the
 * editor attaches without ever producing an editable surface (see
 * docs/pierre-editable-diff-bug.md). A pencil there would be an affordance that does nothing.
 */
export function isEditableDiffType(type: FileDiffMetadata['type']): boolean {
  return type !== 'new' && type !== 'deleted';
}

/** What each annotation carries, so `PierreReviewDiff`'s `renderAnnotation` knows what to draw. */
export type Annotation =
  | { kind: 'threads'; file: string; comments: ReviewComment[] }
  | { kind: 'findings'; file: string; findings: Finding[] }
  | {
      kind: 'composer';
      file: string;
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
 * The version every item in edit mode carries. `hashKey` never returns a negative number, so
 * entering edit mode always changes the version and leaving it always changes it back, while
 * every render in between keeps it put — see `itemVersion`.
 */
const EDIT_VERSION = -1;

// One number per parsed `FileDiffMetadata` object. `useParsedPatchFiles` keeps one parse per
// patch text (a `useMemo`), so the same patch keeps the same objects (and numbers) and a new
// patch gets new ones. A WeakMap, so a dropped parse takes its entries with it.
const diffNumbers = new WeakMap<FileDiffMetadata, number>();
let lastDiffNumber = 0;

/**
 * Names one parse of one file, so a version key can tell "a new patch arrived" apart from "the
 * same patch again" without serialising every line of the diff. Identity rather than contents
 * because Pierre also mutates a partial diff in place when `loadDiffFiles` fills in the rest of
 * the file, and that must not count as a new diff.
 */
function diffNumber(fileDiff: FileDiffMetadata): number {
  const known = diffNumbers.get(fileDiff);
  if (known !== undefined) return known;
  lastDiffNumber += 1;
  diffNumbers.set(fileDiff, lastDiffNumber);
  return lastDiffNumber;
}

/**
 * A 53-bit hash of `text` (two 32-bit multiply-xor lanes folded together), so a version key of
 * any length becomes a safe integer. Two different keys landing on the same number is about one
 * chance in 2^53, which is the only way a real change could go unseen.
 */
function hashKey(text: string): number {
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 2654435761);
    b = Math.imul(b ^ code, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507);
  a ^= Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507);
  b ^= Math.imul(a ^ (a >>> 13), 3266489909);
  return 4294967296 * (2097151 & b) + (a >>> 0);
}

/**
 * The worker-pool cache prefix for one review patch: `review-` plus a hash of the patch text.
 *
 * Pierre keys each file's highlighted render by the prefix and the file's position in the patch
 * (`review-0-1` for the second file), and hands a cached render back for a key it has seen. With
 * a fixed prefix, a patch that changed in place (an applied suggestion, a saved edit, a new
 * agent commit) kept the old keys, so the item's new version redrew the file from the old
 * highlighted lines. A prefix that follows the contents gives a changed patch new keys.
 */
export function reviewCacheKeyPrefix(patch: string): string {
  return `review-${hashKey(patch).toString(36)}`;
}

/**
 * The `version` Pierre's `CodeView` uses to decide whether to read an item again.
 *
 * Pierre keeps the record it already has for an item id until `version` changes
 * (`syncItemRecord` in @pierre/diffs 1.3.1's `CodeView.js`): with the version unchanged it
 * ignores the new annotations, `collapsed` and `fileDiff` outright. So the version is a hash
 * of everything the item draws — which parse of the file it is, whether it is collapsed, and
 * every annotation with its full payload (a reply or a resolve changes a thread's comments,
 * and the thread is drawn from the record Pierre kept) — and changes exactly when one of them
 * does. A comment, composer, new patch or viewed tick then redraws; an unchanged rebuild (a
 * refetch returning the same comments) keeps the number and costs no re-render.
 *
 * In edit mode it is frozen at `EDIT_VERSION` instead. Pierre attaches the editor to the
 * record it holds, and a newer record would re-render the file under the open editor (a new
 * `fileDiff` would even swap the document out from under it), so nothing reaches an edited
 * file until the session ends; then the full key applies again and everything that arrived
 * meanwhile is drawn at once.
 */
function itemVersion(item: {
  fileDiff: FileDiffMetadata;
  annotations: DiffLineAnnotation<Annotation>[];
  collapsed: boolean;
  edit: boolean;
}): number {
  if (item.edit) return EDIT_VERSION;
  return hashKey(
    JSON.stringify([
      diffNumber(item.fileDiff),
      item.collapsed,
      item.annotations,
    ])
  );
}

/**
 * Builds Pierre's per-file `CodeViewDiffItem`s from the parsed patch plus review state layered
 * on top: comment threads, agent findings, an open composer, viewed/collapsed state, and edit
 * mode.
 *
 * Lives outside the component file so it is testable without a DOM: that file's module graph
 * reaches `PierreWorkerPool`'s Vite-only `?worker&url` import, which `bun test` cannot resolve.
 *
 * **The load gate**: `edit` turns on only once `loaded` confirms the file's contents arrived,
 * never from `editing` alone. Pierre attaches an editor to an unloaded item too, but with an
 * empty document — saving that would overwrite the agent's work with nothing.
 *
 * **The version**: Pierre redraws an item only when its `version` changes, so each item's
 * version is derived from what it draws — see `itemVersion`.
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
          ...(composing.startLine !== undefined
            ? { startLine: composing.startLine }
            : {}),
        },
      });
    }

    const edit = editing === fileDiff.name && loaded.has(fileDiff.name);
    // A file you have ticked off collapses, so a long review visibly shrinks as you work
    // through it rather than staying the same size forever — EXCEPT the file actually
    // entering edit mode right now, which is force-expanded regardless of `viewed`.
    // Pierre's own doc comment for `edit` says it is "ignored while `collapsed` is true";
    // without this override, clicking the pencil on a file the reviewer had ticked viewed
    // would resolve the load gate and set `edit: true` while `collapsed` stayed `true` too
    // — Pierre never attaches an editor for it, but the one-file-at-a-time lock (every
    // other pencil hidden, this file's gutter "+" suppressed) is still engaged, with no
    // escape but re-clicking the same pencil.
    const collapsed = edit ? false : (viewed?.has(fileDiff.name) ?? false);

    return {
      id: fileDiff.name,
      type: 'diff',
      fileDiff,
      annotations,
      collapsed,
      edit,
      version: itemVersion({ fileDiff, annotations, collapsed, edit }),
    };
  });
}

/** Why a finished edit session is not being POSTed, or the precondition it will be POSTed with. */
export type EditSaveDecision =
  | { post: false; reason: 'not-requested' | 'no-session' | 'unchanged' }
  | { post: true; baseSha: string };

/**
 * Decides whether a finished edit session should be written back.
 *
 * Pierre ends a session for several reasons — edit turned off, the item collapsed, the item
 * removed from `items` — and only one of them is the reviewer pressing Save. `requestedFile`
 * is what tells those apart, so cancelling or switching files never commits silently.
 *
 * A save whose text is byte-identical to what the session opened with is a no-op too: writing
 * it would stage nothing and `git commit` would fail with "nothing to commit".
 */
export function decideEditSave(input: {
  /** The file the reviewer pressed Save on, or null for any other way a session ended. */
  requestedFile: string | null;
  itemId: string;
  contents: string;
  /** What the session opened with, recorded when the load gate resolved. */
  session: { baseSha: string; contents: string } | undefined;
}): EditSaveDecision {
  if (input.requestedFile !== input.itemId) {
    return { post: false, reason: 'not-requested' };
  }
  if (input.session === undefined) return { post: false, reason: 'no-session' };
  if (input.session.contents === input.contents) {
    return { post: false, reason: 'unchanged' };
  }
  return { post: true, baseSha: input.session.baseSha };
}

/**
 * The server's machine-readable `applyRunEdit` 409 codes, each with a different fix — see
 * `packages/server/src/api.ts`'s `applyRunEdit`.
 *
 * `worktree-busy` and `stale-base` say outright that the edit was not saved, because the editor
 * is already torn down by the time these are shown and the draft is genuinely gone.
 */
const EDIT_ERROR_MESSAGES: Record<string, string> = {
  'worktree-busy':
    "An agent is working here, so this edit wasn't saved. Wait, then redo it.",
  'stale-base':
    'This file changed while you were editing, so this edit was not saved. Reload the diff to see the new version.',
  'worktree-missing': "This run's worktree is gone.",
  'empty-contents': "Couldn't read this file. Nothing was written.",
  'run-reviewed':
    'This run has already been reviewed, so its branch is closed to further edits.',
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
   * Always `null`. `onItemEditComplete` fires only after Pierre has torn the editor down, and
   * re-attaching one cannot be seeded with the reviewer's unsaved draft — so reopening would
   * show on-disk content while implying the draft survived.
   */
  editing: null;
  /**
   * `true` only for `stale-base`, the one failure where disk actually changed underneath the
   * reviewer, which makes the loader's cached contents/sha and the `loaded` marker wrong.
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
