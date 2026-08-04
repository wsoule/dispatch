import type { DiffFile } from '@dispatch/client';
import { Check } from 'lucide-react';
import { useEffect, useMemo } from 'react';

import { normalizeDiffFilePath } from '../../lib/pierreTree';
import { viewedSummary } from '../../lib/reviewViewed';
import { cn } from '@/lib/utils';
import { MetaText, PanelRow } from '@/ui/chrome';

interface ReviewFileTreeProps {
  files: DiffFile[];
  selected: string | null;
  onSelect: (path: string) => void;
  viewed: ReadonlySet<string>;
  onToggleViewed: (path: string) => void;
  /** Unresolved comment count per file, so the list shows where the discussion is. */
  commentsByFile: ReadonlyMap<string, number>;
  unviewedOnly: boolean;
  onToggleUnviewedOnly: () => void;
}

/**
 * The review's changed-files list.
 *
 * An earlier version paired @pierre/trees' `FileTree` with a second, hand-rolled row strip
 * underneath it purely to host a per-file viewed checkbox and comment count — `FileTree` owns
 * its own row rendering and (checked against its published types in
 * `node_modules/@pierre/trees/dist/react/FileTree.d.ts`) exposes no row-renderer or trailing-
 * slot hook a checkbox could ride along in. That put every filename on screen twice. This
 * builds the list from `@/ui/chrome`'s `PanelRow`/`MetaText` instead: one row per file that
 * carries the path, status, comment count and viewed toggle together, so there is nothing left
 * to keep in sync with a second list.
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

  // Mirrors the auto-focus the old `@pierre/trees` model gave for free: when the current
  // selection drops out of the filtered set — e.g. flipping "Unviewed only" hides the file you
  // were just reading — land on the first file the filter still shows, rather than leaving the
  // diff pointed at a file no longer in the list.
  useEffect(() => {
    if (paths.length > 0 && (selected === null || !paths.includes(selected))) {
      onSelect(paths[0]);
    }
  }, [paths, selected, onSelect]);

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
        {shown.map((f) => {
          const path = normalizeDiffFilePath(f.path);
          const isViewed = viewed.has(path);
          const comments = commentsByFile.get(path) ?? 0;
          return (
            <PanelRow
              key={path}
              onClick={() => onSelect(path)}
              className={cn('py-1', path === selected && 'bg-accent/15')}
            >
              {/* Truncates from the left so the filename — the part actually read — survives
                  on a deep path, rather than the leading directories that all look alike. */}
              <span
                dir="rtl"
                title={path}
                className={cn(
                  'dense-meta min-w-0 flex-1 truncate text-left',
                  isViewed && 'opacity-50'
                )}
              >
                {path}
              </span>
              <span
                className={cn(
                  'dense-meta shrink-0',
                  f.status === 'A' && 'text-state-review',
                  f.status === 'D' && 'text-state-failed'
                )}
              >
                {f.status}
              </span>
              {comments > 0 && (
                <MetaText className="text-accent-foreground shrink-0">
                  {comments}
                </MetaText>
              )}
              <button
                type="button"
                role="checkbox"
                aria-checked={isViewed}
                aria-label={`Mark ${path} viewed`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleViewed(path);
                }}
                className={cn(
                  'grid size-3.5 shrink-0 place-items-center rounded-sm',
                  isViewed
                    ? 'bg-state-review text-background'
                    : 'shadow-hairline'
                )}
              >
                {isViewed && <Check className="size-2.5" />}
              </button>
            </PanelRow>
          );
        })}
      </div>
    </div>
  );
}
