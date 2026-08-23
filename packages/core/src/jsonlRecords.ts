// Pure data shapes and parsing, no node:* imports — these take the text of a
// JSONL sidecar rather than a path, so reading the file stays the caller's job.

import type { Finding } from './findings.js';
import type { LedgerEntry } from './ledger.js';

// How an append-only `.dispatch/*.jsonl` sidecar is read back.
//
// The daemon's FindingStore and LedgerStore append a fresh line for every
// write — an update is a new line, never a rewrite — so reading one means
// compacting it. The rule lives here rather than in each store because two
// readers now need to agree on it exactly: the daemon serving the file
// backend at runtime, and the one-time import that moves the same records
// into the database. A second copy of the rule is a copy that can drift, and
// the failure it drifts into is silent — an import that serves a different
// set of findings than the file backend did.

/**
 * The compaction key is `id + createdAt`, not `id` alone.
 *
 * An update re-appends the whole record with its ORIGINAL createdAt, so
 * successive edits collapse onto one key and the last line wins. But two
 * records that independently minted the same id have different createdAt
 * stamps, so both survive — which is deliberate: the file cannot enforce
 * uniqueness, and dropping one would lose a real finding or a real ledger
 * entry rather than a stale revision of one.
 *
 * That tolerance is exactly what the database cannot reproduce, since `id` is
 * a primary key there. `duplicateIds` exists so an importer can report the
 * collision by id instead of silently importing whichever record it saw first.
 */
export interface JsonlScan<T> {
  /** The compacted records, in order of each key's first appearance. */
  records: T[];
  /** Lines that are not valid JSON at all. */
  unparseableLines: string[];
  /** Lines that parse but lack fields every read path dereferences. */
  invalidLines: string[];
  /** Ids carried by more than one distinct record (not just re-written). */
  duplicateIds: string[];
}

// The shared scan. `read` returns the hydrated record, or null for a line
// that parsed into something that is not one of these records at all.
function scanJsonl<T extends { id: string; createdAt: string }>(
  text: string,
  read: (value: unknown) => T | null
): JsonlScan<T> {
  const byRecord = new Map<string, T>();
  const firstKeyForId = new Map<string, string>();
  const unparseableLines: string[] = [];
  const invalidLines: string[] = [];
  const duplicateIds = new Set<string>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A hand-corrupted line costs itself, not the rest of the file.
      unparseableLines.push(line);
      continue;
    }
    const record = read(parsed);
    if (record === null) {
      invalidLines.push(line);
      continue;
    }
    const key = `${record.id}\n${record.createdAt}`;
    const first = firstKeyForId.get(record.id);
    if (first === undefined) firstKeyForId.set(record.id, key);
    else if (first !== key) duplicateIds.add(record.id);
    byRecord.set(key, record);
  }
  return {
    records: [...byRecord.values()],
    unparseableLines,
    invalidLines,
    duplicateIds: [...duplicateIds],
  };
}

// The fields every read path dereferences. A hand-edited line missing one is
// not a finding: without an id, update() writes past it and never edits it.
function readFinding(value: unknown): Finding | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    record.id === '' ||
    typeof record.taskId !== 'string' ||
    typeof record.severity !== 'string' ||
    typeof record.verdict !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.detail !== 'string' ||
    typeof record.createdAt !== 'string'
  ) {
    return null;
  }
  // Older lines pre-date fields the record has since grown, so they are
  // defaulted rather than dropped — a 2025 finding is still a finding. This
  // matters more than it looks: `round`, `updated_at` and `raised_by` are NOT
  // NULL columns, so an undefined one does not degrade the row, it refuses to
  // insert at all and takes the import down with it.
  //
  // `??` throughout, never `||`: an explicit null on runId/file/line/ruling is
  // the real value, and a `round` of 0 must not be rewritten to 0 by accident
  // of falsiness.
  const finding = value as unknown as Finding;
  return {
    ...finding,
    runId: finding.runId ?? null,
    file: finding.file ?? null,
    line: finding.line ?? null,
    ruling: finding.ruling ?? null,
    round: finding.round ?? 0,
    updatedAt: finding.updatedAt ?? finding.createdAt,
    raisedBy: finding.raisedBy ?? '',
  };
}

// Same idea for the ledger. `appliesTo` in particular is checked rather than
// defaulted: entriesFor() calls .includes() on it, and an entry aimed at one
// task reads as an entry aimed at every task under its epic the moment that
// field comes back empty.
function readLedgerEntry(value: unknown): LedgerEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    record.id === '' ||
    typeof record.kind !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.detail !== 'string' ||
    typeof record.createdAt !== 'string' ||
    !Array.isArray(record.appliesTo) ||
    !record.appliesTo.every((t) => typeof t === 'string')
  ) {
    return null;
  }
  // Same defaulting as readFinding, and for the same reason: `authored_by` is
  // a NOT NULL column, so a pre-team entry without one would fail to insert.
  const entry = value as unknown as LedgerEntry;
  return {
    ...entry,
    epicId: entry.epicId ?? null,
    sourceTaskId: entry.sourceTaskId ?? null,
    authoredBy: entry.authoredBy ?? '',
  };
}

/** Reads the text of a `.dispatch/findings.jsonl` back into records. */
export function scanFindingsJsonl(text: string): JsonlScan<Finding> {
  return scanJsonl(text, readFinding);
}

/** Reads the text of a `.dispatch/ledger.jsonl` back into records. */
export function scanLedgerJsonl(text: string): JsonlScan<LedgerEntry> {
  return scanJsonl(text, readLedgerEntry);
}
