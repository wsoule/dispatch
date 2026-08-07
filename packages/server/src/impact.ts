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
}

export type ImpactResult =
  | { ok: true; subject: ImpactSubject; seeds: string[]; reach: ReachResult }
  | { ok: false; reason: 'not-found' | 'outside-root' | 'no-declared-writes' };

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
      break;
    }
  }
  return { ok: true, subject, seeds, reach: deps.depMap().reach(seeds) };
}
