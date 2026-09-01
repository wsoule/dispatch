import type { RunClaim } from '@dispatch/client';
import { claimConflictsWithWrites } from '@dispatch/core/browser';

/** Two live runs whose claimed write sets collide, with the specific claims of `a` that
 * overlap `b`'s set — the detail line the warning strip prints. */
export interface ClaimOverlap {
  a: RunClaim;
  b: RunClaim;
  paths: string[];
}

/**
 * Pairwise collision check over every live run's claims — the "are my parallel agents
 * about to collide?" early warning. Uses core's own `claimConflictsWithWrites` (the same
 * glob-aware predicate the scheduler applies), so this view and dispatch admission can
 * never disagree about what counts as an overlap. Two runs of the same task share their
 * task's writes by definition and are skipped.
 */
export function findClaimOverlaps(claims: RunClaim[]): ClaimOverlap[] {
  const overlaps: ClaimOverlap[] = [];
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i];
      const b = claims[j];
      if (a.taskId === b.taskId) continue;
      if (!claimConflictsWithWrites(a.claims, b.claims)) continue;
      overlaps.push({
        a,
        b,
        paths: a.claims.filter((claim) =>
          claimConflictsWithWrites([claim], b.claims)
        ),
      });
    }
  }
  return overlaps;
}
