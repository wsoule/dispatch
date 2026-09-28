import type { MemoryEntry, MemoryKind, MemoryTrust } from './types.js';

export interface RankContext {
  taskId: string | null;
  epic: string | null;
}

export interface Ranked {
  entry: MemoryEntry;
  matched: boolean;
  score: number; // bm25: lower is a better match
}

export const KIND_CLASS: Record<MemoryKind, 1 | 2 | 3> = {
  constraint: 3,
  hazard: 3,
  decision: 2,
  convention: 2,
  preference: 2,
  fact: 1,
  reference: 1,
};

const TRUST_ORDER: Record<MemoryTrust, number> = {
  human: 3,
  confirmed: 2,
  agent: 1,
};

// Whether an entry is relevant to the context at all; no task context reaches everything.
export function reaches(
  entry: MemoryEntry,
  ctx: RankContext,
  projectKey: string
): boolean {
  if (entry.scope === 'personal')
    return entry.projectKey === null || entry.projectKey === projectKey;
  if (ctx.taskId === null) return true;
  const epicOk = entry.epic === null || entry.epic === ctx.epic;
  const taskOk =
    entry.appliesTo.length === 0 || entry.appliesTo.includes(ctx.taskId);
  return epicOk && taskOk;
}

export function specificity(entry: MemoryEntry, ctx: RankContext): 1 | 2 | 3 {
  if (ctx.taskId !== null && entry.appliesTo.includes(ctx.taskId)) return 3;
  if (ctx.epic !== null && entry.epic === ctx.epic) return 2;
  return 1;
}

function lastUse(entry: MemoryEntry): string {
  const recalled = entry.lastRecalledAt ?? '';
  return recalled > entry.updatedAt ? recalled : entry.updatedAt;
}

// The first key that tells two items apart; keys are thunks so later ones
// are only computed when needed (strict-boolean-expressions rules out `||`).
function firstNonZero(keys: readonly (() => number)[]): number {
  for (const key of keys) {
    const d = key();
    if (d !== 0) return d;
  }
  return 0;
}

// Negative when `a` ranks above `b`: pinned, kind class, specificity, match, trust, recency, id.
export function compareRank(a: Ranked, b: Ranked, ctx: RankContext): number {
  const x = a.entry;
  const y = b.entry;
  return firstNonZero([
    () => Number(y.pinned) - Number(x.pinned),
    () => KIND_CLASS[y.kind] - KIND_CLASS[x.kind],
    () => specificity(y, ctx) - specificity(x, ctx),
    () => Number(b.matched) - Number(a.matched),
    () => (a.matched && b.matched ? a.score - b.score : 0),
    () => TRUST_ORDER[y.trust] - TRUST_ORDER[x.trust],
    () => lastUse(y).localeCompare(lastUse(x)),
    () => x.id.localeCompare(y.id),
  ]);
}

export function rankEntries(
  items: readonly Ranked[],
  ctx: RankContext
): Ranked[] {
  return [...items].sort((a, b) => compareRank(a, b, ctx));
}
