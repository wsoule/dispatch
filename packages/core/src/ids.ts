import { createHash, randomBytes } from 'node:crypto';

import { isContainerKind } from './kinds.js';
import type { TaskKindInput } from './kinds.js';

export function generateTaskId(
  kind: TaskKindInput,
  title: string,
  now: string,
  nonce: string = randomBytes(4).toString('hex'),
  hexLength: number = 6
): string {
  // Every container keeps the `e-` prefix epics always had.
  const prefix = isContainerKind(kind) ? 'e' : 't';
  const hash = createHash('sha256')
    .update(`${now}\n${title}\n${nonce}`)
    .digest('hex')
    .slice(0, hexLength);
  return `${prefix}-${hash}`;
}

/**
 * How many hex characters a task id carries when the board is synced between
 * machines (see packages/server/src/sync).
 *
 * Six is plenty on one machine, which checks every new id against the ids it
 * already holds. Synced machines mint independently and cannot check each
 * other's, and six hex characters is only ~16.7M ids: at a thousand tasks
 * across a team the odds of two machines picking the same one are about 3%,
 * at three thousand about 27%. Eight is ~4.3B, which puts the same boards at
 * roughly 0.01% and 0.1%. The id pattern below accepts both, so a board that
 * starts syncing keeps every id it already has.
 */
export const SYNCED_TASK_ID_HEX = 8;

/** The id generator a synced board mints with. */
export function generateSyncedTaskId(
  kind: TaskKindInput,
  title: string,
  now: string
): string {
  return generateTaskId(kind, title, now, undefined, SYNCED_TASK_ID_HEX);
}

// Same shape as generateTaskId's id (a short, collision-resistant hex tag),
// but for orchestrator runs, which have no title to mix into the hash — a
// timestamp plus a random nonce is enough entropy since runs are created one
// at a time per dispatch call, never in the tight batches task ids can see.
export function generateRunId(
  now: string,
  nonce: string = randomBytes(4).toString('hex'),
  hexLength: number = 6
): string {
  const hash = createHash('sha256')
    .update(`${now}\n${nonce}`)
    .digest('hex')
    .slice(0, hexLength);
  return `r-${hash}`;
}

// Hex characters in a synced board's run ids: 6 reaches even odds of a clash
// near 4,800 team runs, 12 past 20 million (run addresses accept 6 to 12).
export const SYNCED_RUN_ID_HEX = 12;

/** The run id generator a synced board mints with. */
export function generateSyncedRunId(now: string): string {
  return generateRunId(now, undefined, SYNCED_RUN_ID_HEX);
}

// Same shape as generateRunId's id, but for server-side task drafts
// (PlanManager.startDraft) — a draft has no title to mix in yet.
export function generateDraftId(
  now: string,
  nonce: string = randomBytes(4).toString('hex')
): string {
  const hash = createHash('sha256')
    .update(`${now}\n${nonce}`)
    .digest('hex')
    .slice(0, 6);
  return `d-${hash}`;
}

// Same shape as generateRunId's id, but for review findings. Only 6 hex chars,
// so FindingStore re-mints when this hits an id the store already holds.
export function generateFindingId(
  now: string,
  nonce: string = randomBytes(4).toString('hex')
): string {
  const hash = createHash('sha256')
    .update(`${now}\n${nonce}`)
    .digest('hex')
    .slice(0, 6);
  return `f-${hash}`;
}

// Same shape as generateRunId's id, but for ledger entries. Only 6 hex chars,
// so LedgerStore re-mints when this hits an id the store already holds.
export function generateLedgerId(
  now: string,
  nonce: string = randomBytes(4).toString('hex')
): string {
  const hash = createHash('sha256')
    .update(`${now}\n${nonce}`)
    .digest('hex')
    .slice(0, 6);
  return `l-${hash}`;
}

// The shape every task id has: a kind prefix plus generateTaskId's hex tag —
// six characters, or SYNCED_TASK_ID_HEX on a synced board, with room above.
// Both backends gate on this before an id reaches a filename — the file store
// when it resolves a path, the database store when it accepts an imported
// document — so a hand-written id can never steer a write out of the tasks
// directory. Widening the length changes nothing there: it is still hex only.
export const TASK_ID_PATTERN = /^[te]-[0-9a-f]{6,12}$/;

export function isTaskId(value: string): boolean {
  return TASK_ID_PATTERN.test(value);
}

/**
 * The task id at the front of a task file's name (`<id>-<slug>` or just
 * `<id>`), or null when it does not start with one.
 *
 * The id is the hex run after the kind prefix, which ends at the first dash
 * because a dash is not hex — so this reads a six- and an eight-character id
 * alike, where slicing a fixed eight characters off the front would cut a
 * longer id short and read its first eight as someone else's.
 */
export function taskIdFromFilename(name: string): string | null {
  const match = /^([te]-[0-9a-f]{6,12})(?:-|$)/.exec(name);
  return match === null ? null : match[1];
}
