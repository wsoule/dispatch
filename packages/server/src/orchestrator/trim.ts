import type { Dirent } from 'node:fs';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Directory names that hold reinstallable build/dependency output rather than a
 * run's actual work.
 *
 * Measured on a real project: 641MB of a 648MB worktree was `node_modules`. The
 * source checkout — the part that makes a run reviewable — was about 7MB. So
 * reclaiming disk from a run does not require giving up its checkout, which is
 * what the pre-existing `free-disk` action does by removing the whole directory.
 *
 * `.git` is deliberately absent and must stay absent: a worktree's gitdir link is
 * what makes it a worktree at all.
 */
const RECLAIMABLE_DIRS: readonly string[] = ['node_modules', 'dist'];

// Directories never descended into when scanning or trimming. `.git` is
// off-limits (see RECLAIMABLE_DIRS), and skipping it also keeps the scan from
// walking the object store, which can dwarf the working files.
const SKIP_DIRS: readonly string[] = ['.git'];

export interface TrimResult {
  /**
   * Paths removed, relative to the worktree. Deliberately not a byte count:
   * measuring what is about to be deleted costs more than deleting it (see
   * collectReclaimable). Use worktreeDiskUsage beforehand if a number is wanted.
   */
  removed: string[];
}

export interface WorktreeDiskUsage {
  /** Reinstallable output: node_modules, dist. Free to reclaim. */
  dependencyBytes: number;
  /** Everything else — the checkout, which is what makes a run reviewable. */
  checkoutBytes: number;
  totalBytes: number;
}

// Recursively sums file sizes under `dir`. Tolerant by design: a worktree being
// scanned can have files removed underneath it (a review's cleanup, a concurrent
// trim), and a disk-usage readout is not worth throwing over a vanished entry.
function directorySize(dir: string): number {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += directorySize(full);
      continue;
    }
    try {
      total += statSync(full).size;
    } catch {
      // Vanished between readdir and stat — skip it.
    }
  }
  return total;
}

// Finds reclaimable directories WITHOUT measuring or descending into them.
//
// Deliberately cheap: it never stats files and never walks inside a
// `node_modules`, so its cost is proportional to the checkout's directory count
// rather than to the hundreds of thousands of files it is about to delete. An
// earlier version sized each directory before removing it, purely to report a
// byte count in a log line — that measurement ran synchronously on the daemon's
// event loop and cost far more than the deletion itself, enough to blow past
// test timeouts. If a caller wants the number, worktreeDiskUsage is the
// on-demand way to get it.
function collectReclaimable(dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (SKIP_DIRS.includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (RECLAIMABLE_DIRS.includes(entry.name)) {
      out.push(full);
      continue;
    }
    collectReclaimable(full, out);
  }
}

// Walks a worktree, sizing each reclaimable directory and accumulating the size
// of everything else. Only worktreeDiskUsage uses this — it is the expensive
// path, and it exists to answer "what is this costing", not to delete anything.
function walk(
  dir: string,
  onReclaimable: (path: string, bytes: number) => void
): number {
  let otherBytes = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.includes(entry.name)) continue;
      if (RECLAIMABLE_DIRS.includes(entry.name)) {
        onReclaimable(full, directorySize(full));
        continue;
      }
      otherBytes += walk(full, onReclaimable);
      continue;
    }
    try {
      otherBytes += statSync(full).size;
    } catch {
      // Vanished mid-walk — skip it.
    }
  }
  return otherBytes;
}

/**
 * Deletes a worktree's reinstallable dependency/build directories, leaving the
 * checkout, the branch, and the run's reviewability intact.
 *
 * Cheap in every sense that matters: `diff()` is pure git and never needed
 * `node_modules`, the branch ref is untouched so the run stays mergeable, and it
 * self-heals — a `verifyCommand` that starts with an install repopulates whatever
 * a later merge-queue attempt needs.
 *
 * A missing worktree reports zero rather than throwing: once a run is reviewed its
 * worktree is removed, so callers would otherwise have to special-case the common
 * case.
 */
export function trimWorktree(worktreePath: string): TrimResult {
  if (!existsSync(worktreePath)) return { removed: [] };
  const found: string[] = [];
  collectReclaimable(worktreePath, found);
  const removed: string[] = [];
  for (const path of found) {
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(path.slice(worktreePath.length + 1));
    } catch {
      // Leave it; a trim that cannot remove one directory should still remove
      // the rest rather than abandoning the whole worktree.
    }
  }
  return { removed };
}

/**
 * What a worktree costs on disk, split into the part that is free to reclaim and
 * the part that is not. The split is the point: it turns "this run uses 648MB"
 * into "641MB of that is reinstallable", which is the difference between a
 * decision and a number.
 */
export function worktreeDiskUsage(worktreePath: string): WorktreeDiskUsage {
  if (!existsSync(worktreePath)) {
    return { dependencyBytes: 0, checkoutBytes: 0, totalBytes: 0 };
  }
  let dependencyBytes = 0;
  const checkoutBytes = walk(worktreePath, (_path, bytes) => {
    dependencyBytes += bytes;
  });
  return {
    dependencyBytes,
    checkoutBytes,
    totalBytes: dependencyBytes + checkoutBytes,
  };
}
