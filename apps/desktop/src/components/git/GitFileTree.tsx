import type { GitStatus } from '@pierre/trees';
import type { FileTreeRowDecorationContext } from '@pierre/trees';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { useCallback, useEffect, useMemo } from 'react';

import { toTreeGitStatus } from '../../lib/pierreTree';
import type { GitFileRow } from '@/lib/gitPanels';

/** All of one path's rows (a partially staged file appears as both a staged and an
 * unstaged row), plus the flat index of its first row — what selection maps back to. */
interface PathEntry {
  sections: Set<GitFileRow['section']>;
  code?: string;
  firstIndex: number;
}

function indexByPath(rows: GitFileRow[]): Map<string, PathEntry> {
  const byPath = new Map<string, PathEntry>();
  rows.forEach((row, index) => {
    const entry = byPath.get(row.path);
    if (entry === undefined) {
      byPath.set(row.path, {
        sections: new Set([row.section]),
        code: row.code,
        firstIndex: index,
      });
    } else {
      entry.sections.add(row.section);
      entry.code ??= row.code;
    }
  });
  return byPath;
}

function statusFor(entry: PathEntry): GitStatus {
  if (entry.sections.has('untracked')) return 'added';
  if (entry.code !== undefined) return toTreeGitStatus(entry.code);
  return 'modified';
}

/** The one text-or-icon token a tree row carries — the staged/conflicted state the old flat
 * list said with per-row icons. An unstaged, tracked file stays undecorated. */
function decorationFor(
  entry: PathEntry
): { text: string; title: string } | null {
  if (entry.sections.has('conflicted')) {
    return { text: '⚠', title: 'Conflicted' };
  }
  const staged = entry.sections.has('staged');
  const unstaged = entry.sections.has('unstaged');
  if (staged && unstaged) return { text: '±', title: 'Partially staged' };
  if (staged) return { text: '✓', title: 'Staged' };
  if (entry.sections.has('untracked')) return { text: '?', title: 'Untracked' };
  return null;
}

interface GitFileTreeProps {
  rows: GitFileRow[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
}

/**
 * Panel 2's file browser: the working tree as a Pierre `FileTree` (the same tree the review
 * surfaces use) — real directory structure and git-status row colors instead of the old flat
 * mono list, with staged/conflicted/untracked state as the row decoration. Kept in lockstep
 * with the panel's own j/k selection model: the tree's focused path follows `selectedIndex`,
 * and a focus change inside the tree reports back through `onSelectIndex`. Staging stays on
 * space / the diff pane's Stage button / the header's Stage all — a tree row decoration
 * cannot take a click.
 */
export function GitFileTree({
  rows,
  selectedIndex,
  onSelectIndex,
}: GitFileTreeProps) {
  const byPath = useMemo(() => indexByPath(rows), [rows]);
  const paths = useMemo(() => [...byPath.keys()], [byPath]);
  const gitStatus = useMemo(
    () =>
      [...byPath.entries()].map(([path, entry]) => ({
        path,
        status: statusFor(entry),
      })),
    [byPath]
  );

  const renderRowDecoration = useCallback(
    (context: FileTreeRowDecorationContext) => {
      if (context.item.kind !== 'file') return null;
      const entry = byPath.get(context.item.path);
      return entry === undefined ? null : decorationFor(entry);
    },
    [byPath]
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
  }, [model, paths, gitStatus]);

  // Push the panel's selection into the tree; the equality check stops the two models
  // ping-ponging one focus change back and forth.
  const selectedPath = rows[selectedIndex]?.path;
  useEffect(() => {
    if (selectedPath !== undefined && byPath.has(selectedPath)) {
      if (model.getFocusedPath() !== selectedPath) {
        model.focusPath(selectedPath);
      }
    }
  }, [model, selectedPath, byPath]);

  // `FileTree` has no click callback; diffing the focused path across model notifications
  // catches selection by click or the tree's own keys.
  useEffect(() => {
    let last = model.getFocusedPath();
    return model.subscribe(() => {
      const focused = model.getFocusedPath();
      if (focused !== null && focused !== last) {
        const entry = byPath.get(focused);
        if (entry !== undefined) onSelectIndex(entry.firstIndex);
      }
      last = focused;
    });
  }, [model, byPath, onSelectIndex]);

  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground p-3 text-[12px]">
        Working tree clean.
      </div>
    );
  }

  return <FileTree model={model} className="size-full" />;
}
