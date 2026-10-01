import type { LogCursor, PinnedKey } from '@dispatch/federation';
import type { JsonValue } from '@dispatch/protocol';
import type {
  ChainHead,
  FederatedOp,
  OpType,
  ReplicaKeys,
  Sealed,
} from '@dispatch/protocol/federation';
import {
  buildOp,
  canonicalize,
  MAX_OP_BYTES,
  opHash,
  ZERO_HASH,
} from '@dispatch/protocol/federation';
import type { Database } from 'bun:sqlite';

import type { SyncLedger } from '../boardSync/ledger.js';
import type { AuditKind } from './audit.js';
import { AUDIT_KINDS } from './audit.js';
import { FED_SCHEMA } from './schema.js';

/** A signed op over MAX_OP_BYTES, refused before it reaches the outbox. */
export class OpTooLargeError extends Error {
  override name = 'OpTooLargeError';
}

type Stamp = { seq: number; hlc: string };

export interface AppendInput {
  type: OpType;
  body?: JsonValue;
  /** Seals the content under the stamp the op will carry. */
  seal?: (stamp: Stamp) => { to: string[]; sealed: Sealed };
  /** Records whatever else belongs to this op, in the same transaction. */
  onStamp?: (stamp: Stamp) => void;
  /** Receives the signed op before the transaction commits. */
  alsoV1?: (op: FederatedOp) => void;
}

export type FedMetaKey =
  | 'team_id'
  | 'founder'
  | 'founder_seq'
  | 'founder_pin'
  | 'founded_at'
  | 'legacy_until'
  | 'legacy_closed'
  | 'head_seq'
  | 'head_hash'
  | 'head_hlc'
  | 'seq_seen'
  | 'mail_rowid'
  | 'state_since'
  | 'transport'
  | 'transport_url'
  | 'pending_invite'
  | 'device';

interface KeyRow {
  replica: string;
  handle: string;
  device: string;
  build: string;
  sign_pub: string;
  seal_pub: string;
  fingerprint: string;
  key_seq: number;
  legacy_through: number | null;
  legacy_digest: string | null;
  invite_json: string | null;
}

interface CursorRow {
  seq: number | null;
  hash: string | null;
  hlc: string | null;
  halted: string | null;
}

// This replica's federation state in state.db: its signed chain and outbox,
// pinned keys, read cursors, current problems and the append-only audit log.
export class FedStore {
  readonly replica: string;

  constructor(
    private readonly ledger: SyncLedger,
    readonly keys: ReplicaKeys,
    private readonly now: () => Date = () => new Date()
  ) {
    this.replica = ledger.replica;
    ledger.database.exec(FED_SCHEMA);
  }

  get db(): Database {
    return this.ledger.database;
  }

  meta(key: FedMetaKey): string | null {
    const row = this.db
      .query<{ value: string }, [string]>(
        'SELECT value FROM fed_meta WHERE key = ?'
      )
      .get(key);
    return row?.value ?? null;
  }

  setMeta(key: FedMetaKey, value: string | null): void {
    if (value === null) {
      this.db.query('DELETE FROM fed_meta WHERE key = ?').run(key);
      return;
    }
    this.db
      .query(
        'INSERT INTO fed_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value);
  }

  /** This replica's own chain head, or null before its key op. */
  head(): ChainHead | null {
    const seq = this.meta('head_seq');
    const hash = this.meta('head_hash');
    const hlc = this.meta('head_hlc');
    if (seq === null || hash === null || hlc === null) return null;
    return { seq: Number(seq), hash, hlc };
  }

  // Mints the next v2 op, past the v1 counter and chained to the head; the op,
  // the head and the caller's writes under its stamp land in one transaction.
  append(input: AppendInput): FederatedOp {
    return this.ledger.atomically(() => {
      const head = this.head();
      if (head === null && input.type !== 'key')
        throw new Error('the first op of a log is its key op');
      if (head !== null && input.type === 'key')
        throw new Error('a log has one key op');
      const stamp = this.ledger.nextStamp(head?.seq ?? 0);
      input.onStamp?.(stamp);
      const sealedPart = input.seal?.(stamp);
      const op = buildOp(
        {
          replica: this.replica,
          seq: stamp.seq,
          prev: head?.hash ?? ZERO_HASH,
          hlc: stamp.hlc,
          type: input.type,
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(sealedPart === undefined
            ? {}
            : { to: sealedPart.to, sealed: sealedPart.sealed }),
        },
        this.keys.signPriv
      );
      // Measured as verifiers measure it, so nothing published is refused for size.
      const bytes = Buffer.byteLength(canonicalize(op));
      if (bytes > MAX_OP_BYTES)
        throw new OpTooLargeError(
          `a ${input.type} op of ${bytes} bytes is over MAX_OP_BYTES`
        );
      this.db
        .query('INSERT INTO fed_outbox (seq, op_json) VALUES (?, ?)')
        .run(stamp.seq, JSON.stringify(op));
      this.setMeta('head_seq', String(stamp.seq));
      this.setMeta('head_hash', opHash(op));
      this.setMeta('head_hlc', stamp.hlc);
      input.alsoV1?.(op);
      return op;
    });
  }

  /** Moves this replica's clock past a verified op's, so its next op sorts after. */
  observe(hlc: string): void {
    this.ledger.observe(hlc);
  }

  /** Whether an op is stamped too far ahead of this clock to apply yet (FW-R21). */
  ahead(hlc: string): boolean {
    return this.ledger.ahead(hlc);
  }

  /** Signed ops not yet published, oldest first. */
  outbox(): FederatedOp[] {
    return this.db
      .query<{ op_json: string }, []>(
        'SELECT op_json FROM fed_outbox ORDER BY seq'
      )
      .all()
      .map((row) => JSON.parse(row.op_json) as FederatedOp);
  }

  /** Forgets outbox entries once the transport holds them; the head stays. */
  published(throughSeq: number): void {
    this.db.query('DELETE FROM fed_outbox WHERE seq <= ?').run(throughSeq);
  }

  /** Pins a replica's key the first time; keys never rotate in place. */
  pin(key: PinnedKey): 'pinned' | 'same' | 'conflict' {
    const held = this.pinned(key.replica);
    if (held !== null) return samePin(held, key) ? 'same' : 'conflict';
    this.db
      .query(
        `INSERT INTO fed_keys (replica, handle, device, build, sign_pub, seal_pub, fingerprint, key_seq,
           legacy_through, legacy_digest, invite_json, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        key.replica,
        key.handle,
        key.device,
        key.build,
        key.signPub,
        key.sealPub,
        key.fingerprint,
        key.keySeq,
        key.legacy?.throughSeq ?? null,
        key.legacy?.digest ?? null,
        key.invite === undefined ? null : JSON.stringify(key.invite),
        this.now().toISOString()
      );
    return 'pinned';
  }

  pinned(replica: string): PinnedKey | null {
    const row = this.db
      .query<KeyRow, [string]>('SELECT * FROM fed_keys WHERE replica = ?')
      .get(replica);
    return row === null ? null : pinOf(row);
  }

  pins(): PinnedKey[] {
    return this.db
      .query<KeyRow, []>('SELECT * FROM fed_keys ORDER BY replica')
      .all()
      .map(pinOf);
  }

  /** How far this replica has verified another's log. */
  cursor(replica: string): LogCursor {
    const row = this.db
      .query<CursorRow, [string]>(
        'SELECT seq, hash, hlc, halted FROM fed_cursors WHERE replica = ?'
      )
      .get(replica);
    if (row === null) return { head: null, halted: null };
    const head =
      row.seq === null || row.hash === null || row.hlc === null
        ? null
        : { seq: row.seq, hash: row.hash, hlc: row.hlc };
    return { head, halted: row.halted };
  }

  setCursor(replica: string, cursor: LogCursor): void {
    this.db
      .query(
        `INSERT INTO fed_cursors (replica, seq, hash, hlc, halted) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(replica) DO UPDATE SET seq = excluded.seq, hash = excluded.hash, hlc = excluded.hlc, halted = excluded.halted`
      )
      .run(
        replica,
        cursor.head?.seq ?? null,
        cursor.head?.hash ?? null,
        cursor.head?.hlc ?? null,
        cursor.halted
      );
  }

  /** The current problem for a subject, replacing any earlier one. */
  problem(subject: string, message: string): void {
    this.db
      .query(
        'INSERT INTO fed_problems (subject, message, at) VALUES (?, ?, ?) ON CONFLICT(subject) DO UPDATE SET message = excluded.message, at = excluded.at'
      )
      .run(subject, message, this.now().toISOString());
  }

  clearProblem(subject: string): void {
    this.db.query('DELETE FROM fed_problems WHERE subject = ?').run(subject);
  }

  problems(): { subject: string; message: string; at: string }[] {
    return this.db
      .query<{ subject: string; message: string; at: string }, []>(
        'SELECT subject, message, at FROM fed_problems ORDER BY at, subject'
      )
      .all();
  }

  /** Appends a security event; a kind outside AUDIT_KINDS is refused. */
  audit(kind: AuditKind, subject: string, detail: JsonValue): void {
    if (!(AUDIT_KINDS as readonly string[]).includes(kind))
      throw new Error(`${kind} is not an audit kind`);
    this.db
      .query(
        'INSERT INTO fed_audit (at, kind, subject, detail_json) VALUES (?, ?, ?, ?)'
      )
      .run(this.now().toISOString(), kind, subject, JSON.stringify(detail));
  }
}

function pinOf(row: KeyRow): PinnedKey {
  const pin: PinnedKey = {
    replica: row.replica,
    handle: row.handle,
    device: row.device,
    build: row.build,
    signPub: row.sign_pub,
    sealPub: row.seal_pub,
    fingerprint: row.fingerprint,
    keySeq: row.key_seq,
    legacy:
      row.legacy_through === null || row.legacy_digest === null
        ? null
        : { throughSeq: row.legacy_through, digest: row.legacy_digest },
  };
  if (row.invite_json !== null)
    pin.invite = JSON.parse(row.invite_json) as { id: string; sig: string };
  return pin;
}

// Whether two pins carry the same key op's fields, every one of them.
function samePin(a: PinnedKey, b: PinnedKey): boolean {
  return (
    a.replica === b.replica &&
    a.handle === b.handle &&
    a.device === b.device &&
    a.build === b.build &&
    a.signPub === b.signPub &&
    a.sealPub === b.sealPub &&
    a.fingerprint === b.fingerprint &&
    a.keySeq === b.keySeq &&
    a.legacy?.throughSeq === b.legacy?.throughSeq &&
    a.legacy?.digest === b.legacy?.digest &&
    a.invite?.id === b.invite?.id &&
    a.invite?.sig === b.invite?.sig
  );
}
