import type { DiffFile } from '@dispatch/client';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { useEffect, useMemo } from 'react';

import { normalizeDiffFilePath, toTreeGitStatus } from '../../lib/pierreTree';
import { viewedSummary } from '../../lib/reviewViewed';

interface ReviewFileTreeProps {
  files: DiffFile[];
  onSelect: (path: string) => void;
  viewed: ReadonlySet<string>;
  unviewedOnly: boolean;
  onToggleUnviewedOnly: () => void;
}

/**
 * The review's changed-files tree — @pierre/trees' `FileTree`. It has no per-row render slot, so
 * the viewed toggle and comment count that used to duplicate this list now live in `ReviewView`'s
 * diff pane header instead.
 */
export function ReviewFileTree({
  files,
  onSelect,
  viewed,
  unviewedOnly,
  onToggleUnviewedOnly,
}: ReviewFileTreeProps) {
  const shown = useMemo(
    () =>
      unviewedOnly
        ? files.filter((f) => !viewed.has(normalizeDiffFilePath(f.path)))
        : files,
    [files, unviewedOnly, viewed]
  );

  const paths = useMemo(
    () => shown.map((f) => normalizeDiffFilePath(f.path)),
    [shown]
  );
  const gitStatus = useMemo(
    () =>
      shown.map((f) => ({
        path: normalizeDiffFilePath(f.path),
        status: toTreeGitStatus(f.status),
      })),
    [shown]
  );

  const { model } = useFileTree({ paths, gitStatus, initialExpansion: 'open' });

  useEffect(() => {
    model.resetPaths(paths);
    model.setGitStatus(gitStatus);
    const focused = model.getFocusedPath();
    if (paths.length > 0 && (focused === null || !paths.includes(focused))) {
      model.focusPath(paths[0]);
    }
  }, [model, paths, gitStatus]);

  // `FileTree` has no click callback; diffing the focused path across model notifications
  // catches selection by click or keyboard, which a click handler alone would miss.
  useEffect(() => {
    let last = model.getFocusedPath();
    return model.subscribe(() => {
      const focused = model.getFocusedPath();
      if (focused !== null && focused !== last) onSelect(focused);
      last = focused;
    });
  }, [model, onSelect]);

  const allPaths = useMemo(
    () => files.map((f) => normalizeDiffFilePath(f.path)),
    [files]
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <span className="dense-label">Changed files</span>
        <span className="dense-meta">{files.length}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onToggleUnviewedOnly}
          className="text-accent-foreground text-[11px]"
        >
          {unviewedOnly ? 'All' : 'Unviewed'}
        </button>
      </div>
      <p className="dense-meta px-3 pb-1">{viewedSummary(viewed, allPaths)}</p>

      <div className="min-h-0 flex-1 overflow-auto">
        <FileTree model={model} className="size-full" />
      </div>
    </div>
  );
}
