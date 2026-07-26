import type { DiffFile, DiffResult } from '@dispatch/client';
import { FileDiff } from '@pierre/diffs/react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { CircleAlert, FileX } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { splitPatchFiles } from '../../lib/patchFiles';
import { normalizeDiffFilePath, toTreeGitStatus } from '../../lib/pierreTree';
import { ErrorBoundary } from '../shell/ErrorBoundary';
import { PierreWorkerPool } from './PierreWorkerPool';
import { Skeleton } from '@/ui/skeleton';

// The changed-files tree for a run's diff, git-status decorated (added/modified/deleted/
// renamed). A separate component (rather than inlined) because `useFileTree`'s model is
// constructed once from its first-render options, so this only mounts once `files` is known and
// re-syncs imperatively if the diff is refetched while the view stays open. The tree/diff
// widgets themselves are @pierre internals, themed globally via styles/pierreTheme.css.
function ChangedFilesTree({
  files,
  onFileFocus,
}: {
  files: DiffFile[];
  onFileFocus?: (path: string) => void;
}) {
  const paths = useMemo(
    () => files.map((f) => normalizeDiffFilePath(f.path)),
    [files]
  );
  const gitStatus = useMemo(
    () =>
      files.map((f) => ({
        path: normalizeDiffFilePath(f.path),
        status: toTreeGitStatus(f.status),
      })),
    [files]
  );
  const { model } = useFileTree({
    paths,
    gitStatus,
    initialExpansion: 'open',
  });

  useEffect(() => {
    model.resetPaths(paths);
    model.setGitStatus(gitStatus);
    // Diff panes should never sit empty-feeling: auto-focus the first changed file
    // whenever the diff first loads, or whenever a refetch changes the file list out
    // from under the current focus (e.g. the run re-ran and touched different files).
    // Skipped when the existing focus is still one of the current paths so a manual
    // click never gets clobbered by the next poll of the same diff.
    const focused = model.getFocusedPath();
    if (paths.length > 0 && (focused === null || !paths.includes(focused))) {
      model.focusPath(paths[0]);
    }
  }, [model, paths, gitStatus]);

  // Surfaces tree focus changes (clicks and keyboard moves both go through
  // `focusPath`) to the caller so it can scroll the matching file's diff into
  // view. `FileTree` has no click callback prop, but the model notifies its
  // subscribers on every state change, so diffing the focused path across
  // notifications is the supported way to observe row activation. Directory
  // rows report their path too — callers just won't find a diff for them.
  useEffect(() => {
    if (onFileFocus === undefined) return;
    let lastFocused = model.getFocusedPath();
    return model.subscribe(() => {
      const focused = model.getFocusedPath();
      if (focused !== null && focused !== lastFocused) {
        onFileFocus(focused);
      }
      lastFocused = focused;
    });
  }, [model, onFileFocus]);

  return (
    <FileTree
      model={model}
      header={
        <span className="text-muted-foreground block px-3 py-2 text-[11px] tracking-wide uppercase">
          Changed files
        </span>
      }
      className="size-full"
    />
  );
}

/**
 * The shared unified-diff view: one @pierre/diffs `FileDiff` per changed file beside a
 * git-status-decorated @pierre/trees changed-files tree. The run patch is multi-file, and
 * `PatchDiff` is single-file by contract (it throws on patches with more than one file diff),
 * so the patch is split up front with `splitPatchFiles` and rendered as a vertical stack —
 * clicking a file in the tree scrolls its diff into view. Used by both the run Review surface
 * and the Pull Requests view so the code renders identically wherever it's shown. Purely
 * presentational — the `diff`/loading/error are owned by the caller.
 */
export function RunDiffView({
  diff,
  diffLoading,
  diffError,
}: {
  diff: DiffResult | undefined;
  diffLoading: boolean;
  diffError: string | null;
}) {
  const patch = diff?.patch;
  // Parsed once per patch: either the per-file diff metadata or an inline-able
  // error. `null` while there's nothing to parse (no diff yet, or empty patch).
  const parsed = useMemo(
    () =>
      patch === undefined || patch.trim() === ''
        ? null
        : splitPatchFiles(patch),
    [patch]
  );

  // Maps each file's normalized path to its rendered diff section so a tree
  // click can scroll the right section into view. Ref callbacks keep the map
  // in sync as sections mount/unmount across diff refetches.
  const fileSectionRefs = useRef(new Map<string, HTMLDivElement>());
  const handleFileFocus = useCallback((path: string) => {
    fileSectionRefs.current.get(path)?.scrollIntoView({ block: 'start' });
  }, []);

  if (diffLoading) {
    return (
      <div className="grid grid-cols-[14rem_1fr] gap-3">
        <Skeleton className="h-80 rounded-md" />
        <Skeleton className="h-80 rounded-md" />
      </div>
    );
  }
  if (diffError !== null) {
    return (
      <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-10 text-center">
        <CircleAlert className="size-5" />
        <p className="text-[13px]">Couldn&rsquo;t load the diff: {diffError}</p>
      </div>
    );
  }
  if (diff === undefined) return null;

  return (
    <div className="grid min-h-80 grid-cols-[14rem_1fr] gap-3">
      <div className="border-border bg-muted/30 overflow-auto rounded-md border">
        {diff.files.length === 0 ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
            <FileX className="size-4" />
            <p className="text-[12px]">No file changes recorded.</p>
          </div>
        ) : (
          <ChangedFilesTree files={diff.files} onFileFocus={handleFileFocus} />
        )}
      </div>
      <div className="border-border overflow-auto rounded-md border">
        {parsed === null ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
            <FileX className="size-4" />
            <p className="text-[12px]">No changes to show for this run.</p>
          </div>
        ) : parsed.error !== null ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
            <CircleAlert className="size-5" />
            <p className="text-[13px]">
              Couldn&rsquo;t load the diff: {parsed.error}
            </p>
          </div>
        ) : (
          <PierreWorkerPool>
            <div className="flex flex-col">
              {parsed.files.map((file) => {
                const path = normalizeDiffFilePath(file.name);
                return (
                  <div
                    key={path}
                    ref={(node) => {
                      if (node === null) {
                        fileSectionRefs.current.delete(path);
                      } else {
                        fileSectionRefs.current.set(path, node);
                      }
                    }}
                  >
                    {/* Boundary per file, not around the whole stack: one file
                        hitting a render/highlight edge case must degrade to an
                        inline error on that file alone, never blank the other
                        N-1 diffs beside it. */}
                    <ErrorBoundary label={`the diff for ${path}`}>
                      <FileDiff fileDiff={file} />
                    </ErrorBoundary>
                  </div>
                );
              })}
            </div>
          </PierreWorkerPool>
        )}
      </div>
    </div>
  );
}
