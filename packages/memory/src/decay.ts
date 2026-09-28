import { SYSTEM_ADDRESS } from '@dispatch/protocol';

import type { MemoryStore } from './store.js';
import { MEMORY_SCOPES } from './types.js';
import type { MemoryEntry, MemoryScope } from './types.js';

const DAY_MS = 86_400_000;
const RECALL_KEEP_DAYS = 365;

export interface DecayResult {
  staled: number;
  expired: number;
  prunedRecalls: number;
  /** The scopes of the entries it changed, in MEMORY_SCOPES order. */
  scopes: MemoryScope[];
}

// "Use" is the later of the last recall that counted as use and the last change.
function lastUse(e: MemoryEntry): string {
  return e.lastRecalledAt !== null && e.lastRecalledAt > e.updatedAt
    ? e.lastRecalledAt
    : e.updatedAt;
}

// Pinned entries and human constraints written directly as memory never decay.
function exempt(e: MemoryEntry): boolean {
  return (
    e.pinned ||
    (e.kind === 'constraint' && e.trust === 'human' && e.origin === null)
  );
}

// One decay pass over a store in one transaction: fresh → stale → expired by
// idle time, each step a 'decay' revision, then recalls older than a year go.
export function decayStore(
  store: MemoryStore,
  input: { now: Date; staleAfterDays: number; retireAfterDays: number }
): DecayResult {
  const nowMs = input.now.getTime();
  const staleBefore = new Date(
    nowMs - input.staleAfterDays * DAY_MS
  ).toISOString();
  const expireBefore = new Date(
    nowMs - input.retireAfterDays * DAY_MS
  ).toISOString();
  const result: DecayResult = {
    staled: 0,
    expired: 0,
    prunedRecalls: 0,
    scopes: [],
  };
  const changed = new Set<MemoryScope>();
  store.transaction(() => {
    for (const e of store.listEntries({ states: ['active'] })) {
      if (exempt(e) || lastUse(e) >= staleBefore) continue;
      store.updateEntry(
        { ...e, decay: 'stale', rev: e.rev + 1 },
        SYSTEM_ADDRESS,
        'decay'
      );
      result.staled += 1;
      changed.add(e.scope);
    }
    for (const e of store.listEntries({ states: ['stale'] })) {
      if (exempt(e) || lastUse(e) >= expireBefore) continue;
      store.updateEntry(
        { ...e, decay: 'expired', rev: e.rev + 1 },
        SYSTEM_ADDRESS,
        'decay'
      );
      result.expired += 1;
      changed.add(e.scope);
    }
    result.prunedRecalls = store.pruneRecalls(
      new Date(nowMs - RECALL_KEEP_DAYS * DAY_MS).toISOString()
    );
    store.setMeta('last_decay_at', input.now.toISOString());
  });
  result.scopes = MEMORY_SCOPES.filter((scope) => changed.has(scope));
  return result;
}
