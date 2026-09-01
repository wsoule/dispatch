import { createHash, randomBytes } from 'node:crypto';

import type { TaskKind } from './types.js';

export function generateTaskId(
  kind: TaskKind,
  title: string,
  now: string,
  nonce: string = randomBytes(4).toString('hex')
): string {
  const prefix = kind === 'epic' ? 'e' : 't';
  const hash = createHash('sha256')
    .update(`${now}\n${title}\n${nonce}`)
    .digest('hex')
    .slice(0, 6);
  return `${prefix}-${hash}`;
}

// Same shape as generateTaskId's id (a short, collision-resistant hex tag),
// but for orchestrator runs, which have no title to mix into the hash — a
// timestamp plus a random nonce is enough entropy since runs are created one
// at a time per dispatch call, never in the tight batches task ids can see.
export function generateRunId(
  now: string,
  nonce: string = randomBytes(4).toString('hex')
): string {
  const hash = createHash('sha256')
    .update(`${now}\n${nonce}`)
    .digest('hex')
    .slice(0, 6);
  return `r-${hash}`;
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

// The shape every task id has: a kind prefix plus generateTaskId's six hex
// characters. Both backends gate on this before an id reaches a filename —
// the file store when it resolves a path, the database store when it accepts
// an imported document — so a hand-written id can never steer a write out of
// the tasks directory.
export const TASK_ID_PATTERN = /^[te]-[0-9a-f]{6}$/;

export function isTaskId(value: string): boolean {
  return TASK_ID_PATTERN.test(value);
}
