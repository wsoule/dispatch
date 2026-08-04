import type { DiffFile, Finding } from '@dispatch/client';
import type { FileTreeRowDecorationContext } from '@pierre/trees';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { useCallback, useEffect, useMemo } from 'react';

import { normalizeDiffFilePath, toTreeGitStatus } from '../../lib/pierreTree';
import { composeRowDecoration, worstSeverity } from '../../lib/reviewAttention';
import { viewedSummary } from '../../lib/reviewViewed';

interface ReviewFileTreeProps {
  files: DiffFile[];
  onSelect: (path: string) => void;
  viewed: ReadonlySet<string>;
  /** Unresolved comment count per file, so the tree shows where the discussion is. */
  commentsByFile: ReadonlyMap<string, number>;
  /** Open agent-review findings per file, so the tree shows where the machine's attention went. */
  findingsByFile: ReadonlyMap<string, Finding[]>;
  unviewedOnly: boolean;
  onToggleUnviewedOnly: () => void;
}

/**
 * The review's changed-files tree — @pierre/trees' `FileTree`. Viewed ticks and comment counts
 * ride on the rows themselves via `renderRowDecoration`, which takes one text-or-icon value per
 * row. The viewed *toggle* stays in `ReviewView`'s diff pane header, since a decoration cannot
 * take a click.
 */
export function ReviewFileTree({
  files,
  onSelect,
  viewed,
  commentsByFile,
  findingsByFile,
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

  // An earlier version of this file kept a second, flat copy of the whole list below the tree to
  // carry these; `renderRowDecoration` is the per-row slot that removed the need for it.
  const renderRowDecoration = useCallback(
    (context: FileTreeRowDecorationContext) => {
      if (context.item.kind !== 'file') return null;
      return composeRowDecoration({
        viewed: viewed.has(context.item.path),
        comments: commentsByFile.get(context.item.path) ?? 0,
        severity: worstSeverity(findingsByFile.get(context.item.path) ?? []),
      });
    },
    [viewed, commentsByFile, findingsByFile]
  );

  const { model } = useFileTree({
    paths,
    gitStatus,
    initialExpansion: 'open',
    renderRowDecoration,
  });

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
