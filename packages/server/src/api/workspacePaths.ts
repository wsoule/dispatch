import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { worktreePath } from '../orchestrator/paths.js';

/**
 * Resolving a caller-supplied path against the project or one of its
 * worktrees, without ever letting it escape.
 *
 * Shared by the terminal and file routes, which both take "a run, or a path"
 * and both have to answer the same question: which directory is this relative
 * to, and is the result still inside it. Keeping one copy means the traversal
 * guard is written — and reviewed — once.
 */

interface WorkspaceTarget {
  /** The absolute resolved path. */
  path: string;
  /** The directory it was resolved against: the repo, or a run's worktree. */
  base: string;
  /** The run whose worktree `base` is, or null for the project itself. */
  runId: string | null;
}

export type WorkspaceResolution =
  | ({ ok: true } & WorkspaceTarget)
  | { ok: false; message: string };

// What a run id may look like before it is joined onto the worktrees
// directory: one path segment, never `.` or `..`. Real ids are `r-` and six
// hex digits; this is looser than that on purpose, since it only has to keep
// the id from naming a directory other than a run's own.
const RUN_ID_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * The directory a request is scoped to: a run's worktree, or the repo root.
 *
 * The run id is checked before anything else because it chooses the base that
 * `resolveWorkspacePath` then fences `path` inside. An id of `../../..` would
 * move that fence to a directory of the caller's choosing — the user's home,
 * or `/` — and every path under it would pass.
 */
export function resolveWorkspaceBase(
  rootDir: string,
  runId: unknown
):
  | { ok: true; base: string; runId: string | null }
  | { ok: false; message: string } {
  if (typeof runId === 'string' && runId !== '') {
    if (!RUN_ID_SEGMENT.test(runId) || runId === '.' || runId === '..') {
      return { ok: false, message: `not a run id: ${runId}` };
    }
    const base = worktreePath(rootDir, runId);
    if (!existsSync(base)) {
      return { ok: false, message: `run ${runId} has no worktree on disk` };
    }
    return { ok: true, base, runId };
  }
  return { ok: true, base: resolve(rootDir), runId: null };
}

function isInside(path: string, base: string): boolean {
  return path === base || path.startsWith(base + sep);
}

// How many times realLocation walks a path whose deepest existing ancestor
// vanished before it could be resolved. A dangling symlink fails every walk.
const REAL_LOCATION_WALKS = 3;

// Where `path` really lands on disk: its deepest existing ancestor with every
// symlink resolved, plus the part that does not exist yet (a file about to be
// created). Null when that ancestor is a dangling symlink, whose target cannot
// be checked. A file deleted between the walk's lstat and its realpath (a
// checkout switching branches, an agent cleaning up) is walked again from what
// is left, so it reads as a path that does not exist (the routes' 404), never
// as one outside the project; each walk's answer is fenced the same way.
function realLocation(path: string): string | null {
  for (let walk = 0; walk < REAL_LOCATION_WALKS; walk++) {
    const real = realLocationOnce(path);
    if (real !== null) return real;
  }
  return null;
}

// One walk of realLocation: up from `path` to the first ancestor lstat finds,
// then that ancestor's realpath with the missing part joined back on, or null
// when the realpath fails.
function realLocationOnce(path: string): string | null {
  let existing = path;
  const rest: string[] = [];
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) break;
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
  try {
    return join(realpathSync(existing), ...rest);
  } catch {
    return null;
  }
}

/**
 * A path inside the project or a run's worktree.
 *
 * Two checks. The first is on the path's text: `resolve` has collapsed any
 * `..`, and comparing against `base + sep` rather than `base` keeps a sibling
 * whose name merely starts with the base's (`/repo-backup` next to `/repo`)
 * out. The second is on where the path really lands, because a symlink inside
 * the project that points outside it passes the first.
 */
export function resolveWorkspacePath(
  rootDir: string,
  spec: { runId?: unknown; path?: unknown }
): WorkspaceResolution {
  const scope = resolveWorkspaceBase(rootDir, spec.runId);
  if (!scope.ok) return scope;

  const raw = spec.path;
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, path: scope.base, base: scope.base, runId: scope.runId };
  }
  if (typeof raw !== 'string') {
    return { ok: false, message: 'path must be a string' };
  }
  const path = resolve(scope.base, raw);
  const real = realLocation(path);
  const realBase = realLocation(scope.base);
  if (
    !isInside(path, scope.base) ||
    real === null ||
    realBase === null ||
    !isInside(real, realBase)
  ) {
    return {
      ok: false,
      message: 'path must be inside the project or the run’s worktree',
    };
  }
  return { ok: true, path, base: scope.base, runId: scope.runId };
}

/** Whether the resolved path exists and is a directory. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
