import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { DepMap, ReachResult } from './depmap.js';
import { matchesDeclaredWrites } from './orchestrator/review.js';

export type ImpactSubject =
  | { kind: 'file'; path: string }
  | { kind: 'run'; runId: string }
  | { kind: 'task'; taskId: string };

export interface ImpactDeps {
  rootDir: string;
  depMap: () => DepMap;
  changedFilesForRun(runId: string): string[] | null;
  writesForTask(taskId: string): string[] | null;
  trackedFiles(): string[];
  // Whether a relative path exists on disk right now — a tracked file can be
  // deleted, and a brand-new file may not be tracked yet, so neither check
  // alone is enough to tell a typo apart from a real subject.
  fileExists(path: string): boolean;
}

export type ImpactResult =
  | { ok: true; subject: ImpactSubject; seeds: string[]; reach: ReachResult }
  | {
      ok: false;
      reason:
        | 'not-found'
        | 'outside-root'
        | 'no-declared-writes'
        | 'writes-match-nothing';
    };

// Resolves a file subject's path against rootDir and rejects anything that
// escapes it (e.g. `../../etc/passwd`) before any graph call — the seed set
// a reach query runs over must never point outside the repo it was built for.
function seedFromPath(rootDir: string, path: string): string | null {
  const rel = relative(rootDir, resolve(rootDir, path));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  return rel.split(sep).join('/');
}

// True when the graph still references a path that is neither tracked nor
// on disk — something still imports it, or a mirror comment still claims
// it. Either is evidence the path is a real (if currently vanished) file,
// not a typo the graph has never encountered.
function isKnownToDepMap(depMap: DepMap, seed: string): boolean {
  return depMap.dependents(seed).length > 0 || depMap.mirrors(seed).length > 0;
}

// Turns a file, run, or task subject into the seed file set a reach query
// walks. Each subject kind resolves its seeds through a different injected
// collaborator (ImpactDeps) rather than reaching for the daemon's globals
// directly, so this stays testable without a live orchestrator/depmap.
export function computeImpact(
  subject: ImpactSubject,
  deps: ImpactDeps
): ImpactResult {
  let seeds: string[];
  switch (subject.kind) {
    case 'file': {
      const seed = seedFromPath(deps.rootDir, subject.path);
      if (seed === null) return { ok: false, reason: 'outside-root' };
      // A path that is neither tracked nor present on disk is usually a
      // typo, not a file with an empty blast radius — tracked-but-deleted
      // and untracked-but-present are both legitimate, so either check
      // passing is enough. But `git ls-files` reads the index and
      // `fileExists` reads disk, so a `git rm`'d path (removed from both)
      // fails both checks even though it is exactly the case a reviewer
      // most wants reach for. The dependency graph can still know it: a
      // scan that ran while the file existed (or carto's own index) keeps
      // recording it as long as something still imports it or a mirror
      // comment still claims it. That is a real "we know this path", not a
      // guess — a genuine typo has never appeared in the graph either way,
      // so it still 404s.
      if (
        !deps.trackedFiles().includes(seed) &&
        !deps.fileExists(seed) &&
        !isKnownToDepMap(deps.depMap(), seed)
      ) {
        return { ok: false, reason: 'not-found' };
      }
      seeds = [seed];
      break;
    }
    case 'run': {
      const changed = deps.changedFilesForRun(subject.runId);
      if (changed === null) return { ok: false, reason: 'not-found' };
      seeds = changed;
      break;
    }
    case 'task': {
      const writes = deps.writesForTask(subject.taskId);
      if (writes === null) return { ok: false, reason: 'not-found' };
      if (writes.length === 0) {
        return { ok: false, reason: 'no-declared-writes' };
      }
      seeds = deps
        .trackedFiles()
        .filter((file) => matchesDeclaredWrites(writes, file));
      // Declared writes that match nothing (e.g. files not created yet) are
      // a real answer, distinct from declaring no writes at all — both must
      // avoid falling through to a false "0 files affected".
      if (seeds.length === 0) {
        return { ok: false, reason: 'writes-match-nothing' };
      }
      break;
    }
  }
  return { ok: true, subject, seeds, reach: deps.depMap().reach(seeds) };
}
