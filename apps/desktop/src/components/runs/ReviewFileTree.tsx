import type { DiffFile } from '@dispatch/client';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { Check } from 'lucide-react';
import { useEffect, useMemo } from 'react';

import { normalizeDiffFilePath, toTreeGitStatus } from '../../lib/pierreTree';
import { viewedSummary } from '../../lib/reviewViewed';
import { cn } from '@/lib/utils';

interface ReviewFileTreeProps {
  files: DiffFile[];
  selected: string | null;
  onSelect: (path: string) => void;
  viewed: ReadonlySet<string>;
  onToggleViewed: (path: string) => void;
  /** Unresolved comment count per file, so the tree shows where the discussion is. */
  commentsByFile: ReadonlyMap<string, number>;
  unviewedOnly: boolean;
  onToggleUnviewedOnly: () => void;
}

/**
 * The review's changed-files tree — @pierre/trees, the same widget the run diff uses, rather
 * than a hand-rolled list.
 *
 * The tree is what makes a forty-file review navigable: nesting means you can see that eleven
 * of the changes are under `packages/server/src/orchestrator/` without reading eleven paths.
 * A flat list cannot show that, which is why the earlier flat version of this was the wrong
 * shape however it was styled.
 *
 * Viewed ticks and comment counts ride alongside rather than inside the tree: `FileTree` owns
 * its row rendering, so per-row extras live in a strip beneath it keyed to the same paths.
 */
export function ReviewFileTree({
  files,
  selected,
  onSelect,
  viewed,
  onToggleViewed,
  commentsByFile,
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

  // `FileTree` has no click callback, but the model notifies subscribers on every state change,
  // so diffing the focused path across notifications is the supported way to observe a row
  // being activated — by click or by keyboard, which a click handler alone would miss.
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

      {/* The viewed strip. Separate from the tree because FileTree owns its rows — this keys
          off the same normalized paths so the two always agree about what a file is called. */}
      <div className="max-h-40 shrink-0 overflow-auto border-t">
        {shown.map((f) => {
          const path = normalizeDiffFilePath(f.path);
          const isViewed = viewed.has(path);
          const comments = commentsByFile.get(path) ?? 0;
          return (
            <div
              key={path}
              className={cn(
                'flex items-center gap-1.5 px-3 py-0.5',
                path === selected && 'bg-accent/15'
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(path)}
                dir="rtl"
                title={path}
                className={cn(
                  'dense-meta min-w-0 flex-1 truncate text-left',
                  isViewed && 'opacity-50'
                )}
              >
                {path}
              </button>
              {comments > 0 && (
                <span className="dense-meta text-accent-foreground">
                  {comments}
                </span>
              )}
              <button
                type="button"
                role="checkbox"
                aria-checked={isViewed}
                aria-label={`Mark ${path} viewed`}
                onClick={() => onToggleViewed(path)}
                className={cn(
                  'grid size-3.5 shrink-0 place-items-center rounded-sm',
                  isViewed
                    ? 'bg-state-review text-background'
                    : 'shadow-hairline'
                )}
              >
                {isViewed && <Check className="size-2.5" />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
