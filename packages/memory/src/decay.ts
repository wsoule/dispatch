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

// "Use" is the later of the last recall that counted as use and the last
// change, clamped to `now`: a stamp a fast clock wrote never reads as fresh use.
function lastUse(e: MemoryEntry, nowIso: string): string {
  const used =
    e.lastRecalledAt !== null && e.lastRecalledAt > e.updatedAt
      ? e.lastRecalledAt
      : e.updatedAt;
  return used > nowIso ? nowIso : used;
}

// When a sweep marked `e` stale (its last 'decay' revision to stale; the
// entry's own stamp when none did), clamped to `now`.
function staleSince(
  store: MemoryStore,
  e: MemoryEntry,
  nowIso: string
): string {
  const marked = store
    .revisions(e.id)
    .filter((r) => r.cause === 'decay' && r.snapshot.decay === 'stale')
    .at(-1)?.at;
  const since = marked ?? e.updatedAt;
  return since > nowIso ? nowIso : since;
}

// Pinned entries and human constraints written directly as memory never decay.
function exempt(e: MemoryEntry): boolean {
  return (
    e.pinned ||
    (e.kind === 'constraint' && e.trust === 'human' && e.origin === null)
  );
}

// Why the clock cannot be trusted this pass: a far gap since the last sweep,
// or a last sweep in the future. Null when it looks sound.
function clockAnomaly(lastSweep: string | null, nowMs: number): string | null {
  if (lastSweep === null) return null;
  const last = Date.parse(lastSweep);
  if (last > nowMs + FUTURE_SLACK_MS)
    return `clock anomaly: the last sweep (${lastSweep}) is in the future`;
  if (nowMs - last > MAX_SWEEP_GAP_DAYS * DAY_MS)
    return `clock anomaly: ${Math.round((nowMs - last) / DAY_MS)} days since the last sweep (${lastSweep})`;
  return null;
}

// One decay pass over a store in one transaction: fresh → stale by idle time,
// and stale → expired once a sweep marked it stale at least retire − stale
// days ago, each step a 'decay' revision; recalls older than a year go. A
// clock anomaly changes nothing but the sweep stamp.
export function decayStore(
  store: MemoryStore,
  input: { now: Date; staleAfterDays: number; retireAfterDays: number }
): DecayResult {
  const nowMs = input.now.getTime();
  const nowIso = input.now.toISOString();
  const staleBefore = new Date(
    nowMs - input.staleAfterDays * DAY_MS
  ).toISOString();
  const expireBefore = new Date(
    nowMs - input.retireAfterDays * DAY_MS
  ).toISOString();
  const markedBefore = new Date(
    nowMs - (input.retireAfterDays - input.staleAfterDays) * DAY_MS
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
    result.anomaly = clockAnomaly(store.meta('last_decay_at'), nowMs);
    const sound = result.anomaly === null;
    const active = sound ? store.listEntries({ states: ['active'] }) : [];
    const staleBeforeSweep = sound
      ? store.listEntries({ states: ['stale'] })
      : [];
    for (const e of active) {
      if (exempt(e) || lastUse(e, nowIso) >= staleBefore) continue;
      store.updateEntry(
        { ...e, decay: 'stale', rev: e.rev + 1 },
        SYSTEM_ADDRESS,
        'decay',
        nowIso
      );
      result.staled += 1;
      changed.add(e.scope);
    }
    for (const e of staleBeforeSweep) {
      if (exempt(e) || lastUse(e, nowIso) >= expireBefore) continue;
      if (staleSince(store, e, nowIso) > markedBefore) continue;
      store.updateEntry(
        { ...e, decay: 'expired', rev: e.rev + 1 },
        SYSTEM_ADDRESS,
        'decay',
        nowIso
      );
      result.expired += 1;
      changed.add(e.scope);
    }
    result.prunedRecalls = store.pruneRecalls(
      new Date(nowMs - RECALL_KEEP_DAYS * DAY_MS).toISOString()
    );
    store.setMeta('last_decay_at', nowIso);
  });
  result.scopes = MEMORY_SCOPES.filter((scope) => changed.has(scope));
  return result;
}
