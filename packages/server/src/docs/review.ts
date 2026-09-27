import type { RevisionCause } from '@dispatch/core';

// `unreviewed` tells a reader that agent text in a revision has not been
// checked by a human. It is computed from the DAG so no write clears it by accident.

export interface ParentState {
  unreviewed: boolean;
  reviewed: boolean;
}

export interface NewRevisionFacts {
  author: string;
  cause: RevisionCause;
  approval: { by: string; policy?: { rung: number } } | null;
  unverifiedVia: boolean;
  parents: readonly ParentState[];
  restores?: ParentState;
}

export function carriesUnreviewed(p: ParentState): boolean {
  return p.unreviewed && !p.reviewed;
}

// Whether this revision itself brings text no human vouches for. Merges and
// sync folds are mechanical, so they add none of their own.
export function isTainted(
  f: Pick<NewRevisionFacts, 'author' | 'cause' | 'approval' | 'unverifiedVia'>
): boolean {
  if (f.cause === 'merge' || f.cause === 'sync') return false;
  if (f.cause === 'restore') return true;
  if (f.approval?.policy !== undefined) return true;
  if (f.unverifiedVia) return true;
  return !f.author.startsWith('human:');
}

// The flag a new revision is stored with; it never changes afterwards.
export function unreviewedAtCreation(f: NewRevisionFacts): boolean {
  if (f.cause === 'approve' || f.cause === 'reject') {
    // The approver saw the proposal's diff, so only the head parent's state carries.
    if (isTainted(f)) return true;
    return f.parents.length > 0 && carriesUnreviewed(f.parents[0]);
  }
  const inherited =
    f.parents.some(carriesUnreviewed) ||
    (f.restores !== undefined && carriesUnreviewed(f.restores));
  return isTainted(f) || inherited;
}
