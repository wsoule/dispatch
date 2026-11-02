import type { DiffFile, DiffResult } from '@dispatch/client';
import { EmptyState, SkeletonBlock } from '@dispatch/ui';
import type { CodeViewHandle } from '@pierre/diffs/react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { CircleAlert, FileX } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { normalizeDiffFilePath, toTreeGitStatus } from '../../lib/pierreTree';
import { DiffSurface } from '../code/DiffSurface';
import styles from './RunDiffView.module.css';

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
      header={<span className={styles.treeHeader}>Changed files</span>}
      className={styles.tree}
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

  // Loading keeps the two-column frame, a skeleton in each column, so the pane does not jump
  // when the diff arrives.
  if (diffLoading) {
    return (
      <div className={styles.grid} data-run-diff="loading">
        <SkeletonBlock height="100%" label="Loading the changed files" />
        <SkeletonBlock height="100%" label="Loading the diff" />
      </div>
    );
  }
  if (diffError !== null) {
    return (
      <EmptyState icon={<CircleAlert size={22} strokeWidth={1.8} />}>
        Couldn&rsquo;t load the diff: {diffError}
      </EmptyState>
    );
  }
  if (diff === undefined) return null;

  return (
    // `height: 100%` + `min-height: 0` (RunDiffView.module.css `.grid`): this sits inside a
    // flex pane, and with only a minimum height it grew to the diff's full height, so a long
    // diff ran off the bottom with no way to scroll to the rest.
    <div className={styles.grid}>
      <div className={styles.treeColumn}>
        {diff.files.length === 0 ? (
          <EmptyState icon={<FileX size={22} strokeWidth={1.8} />}>
            No file changes recorded.
          </EmptyState>
        ) : (
          <ChangedFilesTree files={diff.files} onFileFocus={handleFileFocus} />
        )}
      </div>
      {/* A flex column, not `overflow: auto`: the scroller has to be `CodeView` itself, and
          its `flex: 1` sizes it off this column directly rather than through a percentage. */}
      <div className={styles.diffColumn}>
        <DiffSurface
          patch={diff.patch}
          emptyLabel="No changes to show for this run."
          viewRef={viewRef}
        />
      </div>
    </div>
  );
}
