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
      // through it rather than staying the same size forever.
      collapsed: viewed?.has(fileDiff.name) ?? false,
      edit,
      version: edit ? 1 : 0,
    };
  });
}

/** The server's machine-readable `applyRunEdit` 409 codes, each with a different fix — see
 * `packages/server/src/api.ts`'s `applyRunEdit`. */
const EDIT_ERROR_MESSAGES: Record<string, string> = {
  'worktree-busy':
    'An agent is working in this worktree — wait for it to finish.',
  'stale-base':
    'This file changed while you were editing. Reload the diff to see the new version.',
  'worktree-missing': "This run's worktree is gone.",
  'empty-contents': "Couldn't read this file — nothing was written.",
};

/** True for the two 409s worth retrying without losing the reviewer's edit: the worktree just
 * needs to free up, or the base moved and a reload will let them decide what to do. The other
 * two (`worktree-missing`, `empty-contents`) describe a run that has nothing left to save into. */
export function isRecoverableEditError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.message === 'worktree-busy' || error.message === 'stale-base')
  );
}

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
