import type { DiffFile, DiffResult } from '@dispatch/client';
import type { CodeViewHandle } from '@pierre/diffs/react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { CircleAlert, FileX } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { normalizeDiffFilePath, toTreeGitStatus } from '../../lib/pierreTree';
import { DiffSurface } from '../code/DiffSurface';
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
 * The shared unified-diff view: the whole run patch in one `DiffSurface` beside a
 * git-status-decorated @pierre/trees changed-files tree — clicking a file in the tree scrolls
 * its diff into view within that one scroller. Used by both the run Review surface and the Pull
 * Requests view so the code renders identically wherever it's shown. Purely presentational —
 * the `diff`/loading/error are owned by the caller.
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
  // Every file lives in one virtualized scroller now, so a tree click scrolls the surface to
  // that item rather than calling `scrollIntoView` on a per-file section that no longer exists.
  // Tree paths and item ids are both the diff's file path. An id Pierre doesn't know is simply
  // a no-op — a directory row, or a rename, whose server path (`old\tnew`, normalized to the
  // destination) can differ from Pierre's own name for the file, exactly as before.
  const viewRef = useRef<CodeViewHandle<undefined>>(null);
  const handleFileFocus = useCallback((path: string) => {
    viewRef.current?.scrollTo({ type: 'item', id: path, align: 'start' });
  }, []);

  if (diffLoading) {
    return (
      <div className="grid h-full min-h-0 grid-cols-[14rem_1fr] gap-3">
        <Skeleton className="rounded-md" />
        <Skeleton className="rounded-md" />
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
    // h-full + min-h-0, not min-h-80: this sits inside a flex pane, and with
    // only a minimum it grew to the diff's full height instead of the pane's.
    // Its overflow-auto columns then had nothing bounding them, so a long diff
    // simply ran off the bottom with no way to scroll to the rest.
    <div className="grid h-full min-h-0 grid-cols-[14rem_1fr] gap-3">
      <div className="border-border bg-muted/30 min-h-0 overflow-auto rounded-md border">
        {diff.files.length === 0 ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
            <FileX className="size-4" />
            <p className="text-[12px]">No file changes recorded.</p>
          </div>
        ) : (
          <ChangedFilesTree files={diff.files} onFileFocus={handleFileFocus} />
        )}
      </div>
      {/* A flex column, not `overflow-auto`: the scroller has to be `CodeView` itself, and
          `flex-1` sizes it off this column directly rather than through a percentage. */}
      <div className="border-border flex min-h-0 flex-col overflow-hidden rounded-md border">
        <DiffSurface
          patch={diff.patch}
          emptyLabel="No changes to show for this run."
          viewRef={viewRef}
        />
      </div>
    </div>
  );
}
