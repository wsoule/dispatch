import type { JsonValue } from '@dispatch/protocol';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { FedStore } from './store.js';

// Every kind fed_audit records (spec "The audit log"); FedStore.audit takes
// only these, and each emitting feature writes and tests its own.
export const AUDIT_KINDS = [
  'founding',
  'trust',
  'invite',
  'admission',
  'role',
  'hosts',
  'observer',
  'license',
  'revocation',
  'recovery',
  'legacy-close',
  'transport',
  'dismiss',
  'reissue',
  'fork',
  'halt',
  'bad-signature',
  'speaks-for',
  'refused-message',
  'run-conflict',
  'clock-hold',
] as const;

export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface AuditRow {
  id: number;
  at: string;
  kind: AuditKind;
  subject: string;
  detail: JsonValue;
}

/** fed_audit rows after `id`, oldest first, at most `limit`. */
export function auditSince(
  fed: FedStore,
  id: number,
  limit = 1000
): AuditRow[] {
  return fed.db
    .query<
      {
        id: number;
        at: string;
        kind: AuditKind;
        subject: string;
        detail_json: string;
      },
      [number, number]
    >(
      'SELECT id, at, kind, subject, detail_json FROM fed_audit WHERE id > ? ORDER BY id LIMIT ?'
    )
    .all(id, limit)
    .map((r) => ({
      id: r.id,
      at: r.at,
      kind: r.kind,
      subject: r.subject,
      detail: JSON.parse(r.detail_json) as JsonValue,
    }));
}

/** Appends rows past fed_meta's audit_exported to <dir>/federation/audit.jsonl
 *  and records the new id; the file is never read back. Returns rows written. */
export function appendAuditToReceipts(fed: FedStore, dir: string): number {
  let after = Number(fed.meta('audit_exported') ?? 0);
  let written = 0;
  for (;;) {
    const rows = auditSince(fed, after);
    const last = rows.at(-1);
    if (last === undefined) return written;
    mkdirSync(join(dir, 'federation'), { recursive: true });
    appendFileSync(
      join(dir, 'federation', 'audit.jsonl'),
      rows.map((r) => `${JSON.stringify(r)}\n`).join('')
    );
    after = last.id;
    fed.setMeta('audit_exported', String(after));
    written += rows.length;
  }
}
