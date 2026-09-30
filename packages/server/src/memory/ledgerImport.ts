import { isValidAssignee, TASK_ID_PATTERN } from '@dispatch/core';
import type { LedgerEntry, LedgerKind } from '@dispatch/core';
import {
  cutUtf8,
  insertFresh,
  MEMORY_LIMITS,
  newMemoryEntry,
  newProposal,
  utf8Bytes,
} from '@dispatch/memory';
import type { MemoryIds, MemoryStore } from '@dispatch/memory';
import { LINE_BREAK, SYSTEM_ADDRESS } from '@dispatch/protocol';

import {
  DEP_MAP_DEGRADED_TITLE,
  scopeExtensionTitle,
  UNDECLARED_WRITES_TITLE,
} from '../ledger.js';

type AuditReason =
  | 'handoff'
  | 'policy'
  | 'floor'
  | 'scope'
  | 'undeclared-writes'
  | 'dep-map';
export type LedgerClass =
  | { to: 'memory' }
  | { to: 'audit'; reason: AuditReason };

const ACTOR_REF = /^(human|agent):/;
const AUDIT_REASONS: readonly AuditReason[] = [
  'policy',
  'floor',
  'scope',
  'undeclared-writes',
  'dep-map',
  'handoff',
];
const LEDGER_KIND_ORDER: readonly LedgerKind[] = [
  'constraint',
  'hazard',
  'decision',
  'handoff',
];
const ROLLBACK = Symbol('rollback');

// Sorts a ledger row into memory or the audit trail; the first matching rule wins.
export function classifyLedgerEntry(entry: LedgerEntry): LedgerClass {
  const audit = (reason: AuditReason): LedgerClass => ({ to: 'audit', reason });
  if (entry.kind === 'handoff') return audit('handoff');
  if (entry.detail.includes('auto-decided by ')) return audit('policy');
  if (entry.detail.includes('held by the irreversibility floor ('))
    return audit('floor');
  if (entry.title.startsWith(scopeExtensionTitle(''))) return audit('scope');
  if (entry.authoredBy === 'none' && UNDECLARED_WRITES_TITLE.test(entry.title))
    return audit('undeclared-writes');
  if (entry.authoredBy === 'none' && entry.title === DEP_MAP_DEGRADED_TITLE)
    return audit('dep-map');
  return { to: 'memory' };
}

// Ledger ids repeat with different createdAt, so the origin carries both.
export function ledgerOrigin(entry: LedgerEntry): string {
  return `ledger:${entry.id}@${entry.createdAt}`;
}

function isLedgerKind(kind: string): kind is LedgerKind {
  return (LEDGER_KIND_ORDER as readonly string[]).includes(kind);
}

const isText = (value: unknown): boolean => typeof value === 'string';

// Core's reader leaves the ids and author unchecked, so a hand-edited line can
// hold any JSON there; a row naming targets but no task id reached no task.
function isDamaged(row: LedgerEntry): boolean {
  if (!isLedgerKind(row.kind)) return true;
  if (row.epicId !== null && !isText(row.epicId)) return true;
  if (row.sourceTaskId !== null && !isText(row.sourceTaskId)) return true;
  if (!isText(row.authoredBy)) return true;
  return (
    row.appliesTo.length > 0 &&
    !row.appliesTo.some((id) => TASK_ID_PATTERN.test(id))
  );
}

function oneLine(text: string): string {
  return text.split(LINE_BREAK).join(' ').trim();
}

// Title cut to the title limit (overflow opens the body); a body over the
// body limit is cut with a marker naming the bytes dropped.
function ledgerContent(entry: LedgerEntry): {
  title: string;
  body: string;
  truncated: boolean;
} {
  const folded = oneLine(entry.title);
  const flat = folded === '' ? '(untitled ledger entry)' : folded;
  const title = cutUtf8(flat, MEMORY_LIMITS.titleBytes);
  const overflow = flat.slice(title.length).trim();
  const body =
    overflow === '' ? entry.detail : `${overflow}\n\n${entry.detail}`;
  const size = utf8Bytes(body);
  if (size <= MEMORY_LIMITS.bodyBytes) return { title, body, truncated: false };
  const marker = (dropped: number) =>
    `\n[truncated on import: ${dropped} bytes]`;
  const kept = cutUtf8(body, MEMORY_LIMITS.bodyBytes - utf8Bytes(marker(size)));
  return {
    title,
    body: kept + marker(size - utf8Bytes(kept)),
    truncated: true,
  };
}

export interface LedgerImportReport {
  outcome: 'ok' | 'MISMATCH' | 'dry-run';
  read: number;
  byKind: Record<LedgerKind, number>;
  memory: {
    total: number;
    imported: number;
    proposed: number;
    /** Rows cut to fit: a body over 8 KiB or more than 50 distinct targets. */
    truncated: number;
    alreadyImported: number;
    alreadyDeleted: number;
  };
  audit: Record<AuditReason, number> & { total: number };
  damaged: number;
  memoryRows: { before: number; after: number };
  openProposals: { before: number; after: number };
  mismatches: string[];
  at: string;
}

export interface LedgerImportInput {
  rows: readonly LedgerEntry[];
  damaged: number;
  store: MemoryStore;
  ids: MemoryIds;
  now: Date;
  cutoverAt: string | null;
  // An import has run since the cutover, so every unseen row came from
  // elsewhere, whatever createdAt it claims.
  cutoverSwept: boolean;
  dryRun?: boolean;
}

/**
 * Imports every lesson row once, in one transaction, and proves count parity or rolls back.
 * Call it outside any transaction: nested, its rollback would leave its writes to the outer commit.
 */
export function importLedger(input: LedgerImportInput): LedgerImportReport {
  const { store, ids, cutoverAt, cutoverSwept } = input;
  const at = input.now.toISOString();
  const nowMs = input.now.getTime();
  const byKind: Record<LedgerKind, number> = {
    constraint: 0,
    hazard: 0,
    decision: 0,
    handoff: 0,
  };
  const memory = {
    total: 0,
    imported: 0,
    proposed: 0,
    truncated: 0,
    alreadyImported: 0,
    alreadyDeleted: 0,
  };
  const audit: LedgerImportReport['audit'] = {
    total: 0,
    policy: 0,
    floor: 0,
    scope: 0,
    'undeclared-writes': 0,
    'dep-map': 0,
    handoff: 0,
  };
  const read = input.rows.length + input.damaged;
  let damaged = input.damaged;
  let before = { rows: 0, open: 0 };
  let after = before;
  const mismatches: string[] = [];
  try {
    store.transaction(() => {
      before = { rows: store.countEntries(), open: store.countOpenProposals() };
      for (const row of input.rows) {
        if (isDamaged(row)) {
          damaged += 1;
          continue;
        }
        byKind[row.kind] += 1;
        const cls = classifyLedgerEntry(row);
        if (cls.to === 'audit') {
          audit[cls.reason] += 1;
          audit.total += 1;
          continue;
        }
        memory.total += 1;
        const origin = ledgerOrigin(row);
        if (store.isTombstoned(origin)) {
          memory.alreadyImported += 1;
          memory.alreadyDeleted += 1;
          continue;
        }
        if (
          store.entryByOrigin(origin) !== null ||
          store.proposalByOrigin(origin) !== null
        ) {
          memory.alreadyImported += 1;
          continue;
        }
        const content = ledgerContent(row);
        const kind = row.kind as Exclude<LedgerKind, 'handoff'>;
        const taskId =
          row.sourceTaskId !== null && TASK_ID_PATTERN.test(row.sourceTaskId)
            ? row.sourceTaskId
            : null;
        const refs =
          taskId === null ? [] : [{ type: 'task' as const, id: taskId }];
        const epic =
          row.epicId !== null && TASK_ID_PATTERN.test(row.epicId)
            ? row.epicId
            : null;
        const targets = [
          ...new Set(row.appliesTo.filter((id) => TASK_ID_PATTERN.test(id))),
        ];
        const appliesTo = targets.slice(0, MEMORY_LIMITS.appliesTo);
        if (content.truncated || targets.length > appliesTo.length)
          memory.truncated += 1;
        if (
          cutoverAt !== null &&
          (cutoverSwept ||
            row.createdAt > cutoverAt ||
            Number.isNaN(Date.parse(row.createdAt)))
        ) {
          // The row's claimed author rides in `reason` as untrusted text; the
          // proposal itself is the system's.
          const claim = oneLine(row.authoredBy);
          const reason = `ledger row arrived after the cutover; it claims author ${claim === '' ? '(none)' : claim}`;
          store.insertProposal(
            newProposal(
              {
                action: 'add',
                scope: 'team',
                author: SYSTEM_ADDRESS,
                authorTrust: 'agent',
                content: {
                  kind,
                  title: content.title,
                  body: content.body,
                  refs,
                  epic,
                  appliesTo,
                },
                reason: cutUtf8(reason, MEMORY_LIMITS.reasonBytes),
                taskId,
                origin,
              },
              ids.proposal(nowMs),
              at
            )
          );
          memory.proposed += 1;
          continue;
        }
        const author =
          ACTOR_REF.test(row.authoredBy) && isValidAssignee(row.authoredBy)
            ? row.authoredBy
            : SYSTEM_ADDRESS;
        insertFresh(
          store,
          ids,
          nowMs,
          (id) =>
            newMemoryEntry(
              {
                scope: 'team',
                kind,
                title: content.title,
                body: content.body,
                refs,
                epic,
                appliesTo,
                author,
                trust: 'agent',
                origin,
                createdAt: row.createdAt,
                lastRecalledAt: at,
              },
              id,
              at
            ),
          SYSTEM_ADDRESS,
          'import'
        );
        memory.imported += 1;
      }
      after = { rows: store.countEntries(), open: store.countOpenProposals() };
      if (read !== memory.total + audit.total + damaged)
        mismatches.push(
          `read ${read} ≠ memory ${memory.total} + audit ${audit.total} + damaged ${damaged}`
        );
      if (
        memory.total !==
        memory.imported + memory.proposed + memory.alreadyImported
      )
        mismatches.push(
          `memory ${memory.total} ≠ imported ${memory.imported} + proposed ${memory.proposed} + already ${memory.alreadyImported}`
        );
      if (after.rows !== before.rows + memory.imported)
        mismatches.push(
          `memory rows ${after.rows} ≠ ${before.rows} + ${memory.imported}`
        );
      if (after.open !== before.open + memory.proposed)
        mismatches.push(
          `open proposals ${after.open} ≠ ${before.open} + ${memory.proposed}`
        );
      if (mismatches.length > 0 || input.dryRun === true) throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  let outcome: LedgerImportReport['outcome'] = 'ok';
  if (mismatches.length > 0) outcome = 'MISMATCH';
  else if (input.dryRun === true) outcome = 'dry-run';
  return {
    outcome,
    read,
    byKind,
    memory,
    audit,
    damaged,
    memoryRows: { before: before.rows, after: after.rows },
    openProposals: { before: before.open, after: after.open },
    mismatches,
    at,
  };
}

// The parity block: labels padded to 22 columns and counts to 5, then the breakdown.
export function renderImportReport(r: LedgerImportReport): string {
  const line = (label: string, count: number, detail = '') =>
    `${label.padEnd(22)}${String(count).padStart(5)}${detail === '' ? '' : `   (${detail})`}`;
  const kinds = LEDGER_KIND_ORDER.map((k) => `${k} ${r.byKind[k]}`).join(' · ');
  const mem = `imported ${r.memory.imported} · proposed ${r.memory.proposed} · truncated ${r.memory.truncated} · already imported ${r.memory.alreadyImported}, of which deleted ${r.memory.alreadyDeleted}`;
  const aud = AUDIT_REASONS.map(
    (reason) => `${reason} ${r.audit[reason]}`
  ).join(' · ');
  return [
    r.outcome === 'MISMATCH'
      ? `outcome: MISMATCH — ${r.mismatches.join('; ')}`
      : `outcome: ${r.outcome}`,
    line('ledger rows read', r.read, kinds),
    line('→ memory', r.memory.total, mem),
    line('→ audit-only', r.audit.total, aud),
    line('damaged', r.damaged),
    `memory rows       ${r.memoryRows.before} → ${r.memoryRows.after}`,
    `open proposals    ${r.openProposals.before} → ${r.openProposals.after}`,
  ].join('\n');
}
