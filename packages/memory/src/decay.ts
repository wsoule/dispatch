import { SYSTEM_ADDRESS } from '@dispatch/protocol';

import type { MemoryStore } from './store.js';
import { MEMORY_SCOPES } from './types.js';
import type { MemoryEntry, MemoryScope } from './types.js';

const DAY_MS = 86_400_000;
const RECALL_KEEP_DAYS = 365;
// Sweeps run daily; a gap past this reads as a clock jump, not a pause.
const MAX_SWEEP_GAP_DAYS = 7;
// Skew tolerated before a stamp counts as from the future.
const FUTURE_SLACK_MS = 5 * 60_000;

export interface DecayResult {
  staled: number;
  expired: number;
  prunedRecalls: number;
  /** The scopes of the entries it changed, in MEMORY_SCOPES order. */
  scopes: MemoryScope[];
  /** Why this pass only marked stale (a clock anomaly); null otherwise. */
  anomaly: string | null;
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

// Why the clock cannot be trusted for retiring: a far gap since the last
// sweep, or a stamp in the future. Null when it looks sound.
function clockAnomaly(
  entries: readonly MemoryEntry[],
  lastSweep: string | null,
  nowMs: number
): string | null {
  const limit = nowMs + FUTURE_SLACK_MS;
  const last = lastSweep === null ? Number.NaN : Date.parse(lastSweep);
  if (last > limit)
    return `clock anomaly: the last sweep (${lastSweep}) is in the future`;
  if (nowMs - last > MAX_SWEEP_GAP_DAYS * DAY_MS)
    return `clock anomaly: ${Math.round((nowMs - last) / DAY_MS)} days since the last sweep (${lastSweep})`;
  for (const e of entries) {
    for (const stamp of [e.createdAt, e.updatedAt, e.lastRecalledAt]) {
      if (stamp !== null && Date.parse(stamp) > limit)
        return `clock anomaly: entry ${e.id} has a stamp in the future (${stamp})`;
    }
  }
  return null;
}

// One decay pass over a store in one transaction: fresh → stale by idle time,
// and stale → expired only for entries an earlier sweep marked stale, each step
// a 'decay' revision; recalls older than a year go. A clock anomaly skips expiry.
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
    anomaly: null,
  };
  const changed = new Set<MemoryScope>();
  store.transaction(() => {
    const active = store.listEntries({ states: ['active'] });
    const staleBeforeSweep = store.listEntries({ states: ['stale'] });
    result.anomaly = clockAnomaly(
      [...active, ...staleBeforeSweep],
      store.meta('last_decay_at'),
      nowMs
    );
    for (const e of active) {
      if (exempt(e) || lastUse(e) >= staleBefore) continue;
      store.updateEntry(
        { ...e, decay: 'stale', rev: e.rev + 1 },
        SYSTEM_ADDRESS,
        'decay'
      );
      result.staled += 1;
      changed.add(e.scope);
    }
    for (const e of result.anomaly === null ? staleBeforeSweep : []) {
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
