import { dbVersion, openSqliteDb, queryAll, queryOne } from '@dispatch/core';
import type { SqliteDatabase, SqlValue } from '@dispatch/core';

import type { Address } from './address.js';
import { hasGateData } from './constants.js';
import { isSystemMarker } from './envelope.js';
import type { JsonValue, Message, MessageKind, Ref } from './envelope.js';
import { DELIVERY_STATES, REMOTE_STATES } from './store.js';
import type {
  AgentRecord,
  AgentStatus,
  ChannelRecord,
  Delivery,
  DeliveryFilter,
  DeliveryState,
  DeliveryVia,
  MessageStore,
  RemoteDelivery,
  RemoteState,
  SettledAs,
  Settlement,
  StoredMeta,
  ThreadSummary,
} from './store.js';

export const MESSAGES_DB_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, thread TEXT NOT NULL, reply_to TEXT, from_addr TEXT NOT NULL,
  session TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, refs_json TEXT NOT NULL,
  data_json TEXT, urgent INTEGER NOT NULL, blocking INTEGER NOT NULL,
  choices_json TEXT, choice TEXT, wake TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread, id);
CREATE INDEX IF NOT EXISTS messages_reply ON messages (reply_to);
CREATE INDEX IF NOT EXISTS messages_from ON messages (from_addr, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS messages_one_answer ON messages (reply_to) WHERE kind = 'answer';
CREATE TABLE IF NOT EXISTS recipients (
  message_id TEXT NOT NULL, position INTEGER NOT NULL, addr TEXT NOT NULL,
  PRIMARY KEY (message_id, position)
);
CREATE INDEX IF NOT EXISTS recipients_addr ON recipients (addr);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, recipient TEXT NOT NULL,
  run_id TEXT, via TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_recipient ON deliveries (recipient, state);
CREATE INDEX IF NOT EXISTS deliveries_message ON deliveries (message_id);
CREATE INDEX IF NOT EXISTS deliveries_run ON deliveries (run_id);
CREATE TABLE IF NOT EXISTS channels (
  name TEXT PRIMARY KEY, created_at TEXT NOT NULL, auto INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  channel TEXT NOT NULL, addr TEXT NOT NULL, joined_at TEXT NOT NULL,
  PRIMARY KEY (channel, addr)
);
CREATE TABLE IF NOT EXISTS agents (
  addr TEXT PRIMARY KEY, display_name TEXT NOT NULL, client TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL, muted INTEGER NOT NULL,
  approved_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gate_effects (
  question_id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS voided_answers (
  answer_id TEXT PRIMARY KEY, question_id TEXT NOT NULL, at TEXT NOT NULL
);
`;

// Opens (creating if needed) a messages database and applies its schema;
// refuses a file stamped by a newer build rather than downgrading it.
export function openMessagesDb(path: string): SqliteDatabase {
  const db = openSqliteDb(path);
  const existing = dbVersion(db);
  if (existing > MESSAGES_DB_VERSION) {
    db.close();
    throw new Error(
      `messages database at ${path} was written by a newer schema (version ${existing}, this build understands ${MESSAGES_DB_VERSION})`
    );
  }
  db.exec(DDL);
  addIdemKey(db);
  addFederationSchema(db);
  addMessageRefs(db);
  db.exec(`PRAGMA user_version = ${MESSAGES_DB_VERSION}`);
  return db;
}

// Additive, so an older build still opens and writes the file: its insert names
// its columns and leaves idem_key NULL, which the partial index ignores.
export function addIdemKey(db: SqliteDatabase): void {
  if (!hasIdemKey(db)) {
    try {
      db.exec('ALTER TABLE messages ADD COLUMN idem_key TEXT');
    } catch (err) {
      // A daemon opening the same file at once may have added it first.
      if (!hasIdemKey(db)) throw err;
    }
  }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS messages_idem ON messages (from_addr, idem_key) WHERE idem_key IS NOT NULL'
  );
}

function hasIdemKey(db: SqliteDatabase): boolean {
  return messageColumns(db).has('idem_key');
}

function messageColumns(db: SqliteDatabase): Set<string> {
  return new Set(
    queryAll<{ name: string }>(db, 'PRAGMA table_info(messages)').map(
      (c) => c.name
    )
  );
}

const FEDERATION_DDL = `
CREATE TABLE IF NOT EXISTS remote_deliveries (
  message_id TEXT NOT NULL, recipient TEXT NOT NULL, via TEXT NOT NULL,
  state TEXT NOT NULL, homes_json TEXT NOT NULL, wake_at TEXT, refused_by TEXT,
  updated_at TEXT NOT NULL, PRIMARY KEY (message_id, recipient)
);
CREATE INDEX IF NOT EXISTS remote_recipient ON remote_deliveries (recipient, state);
CREATE TABLE IF NOT EXISTS settlements (
  question_id TEXT PRIMARY KEY, answer_id TEXT, closed_reason TEXT,
  settler TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS early_settlements (
  question_id TEXT NOT NULL, settler TEXT NOT NULL, answer_id TEXT,
  closed_reason TEXT, at TEXT NOT NULL, PRIMARY KEY (question_id, settler)
);
`;
const FEDERATION_COLUMNS = [
  'origin',
  'hlc',
  'received_at',
  'settled_as',
] as const;
const SETTLED_AS: readonly SettledAs[] = [
  'pending',
  'accepted',
  'superseded',
  'candidate',
];

// Additive, like addIdemKey: an older build names its columns on insert and
// never reads these, so it keeps opening and writing the file.
function addFederationSchema(db: SqliteDatabase): void {
  const have = messageColumns(db);
  for (const column of FEDERATION_COLUMNS) {
    if (have.has(column)) continue;
    try {
      db.exec(`ALTER TABLE messages ADD COLUMN ${column} TEXT`);
    } catch (err) {
      // A daemon opening the same file at once may have added it first.
      if (!messageColumns(db).has(column)) throw err;
    }
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS messages_thread_hlc ON messages (thread, hlc, id)'
  );
  db.exec(FEDERATION_DDL);
}

// Additive: refs by (type, id), so a doc's or task's talk is one indexed read.
// Created with a one-time backfill from refs_json; an older build's inserts
// skip it, which a later open does not repair.
function addMessageRefs(db: SqliteDatabase): void {
  const existed =
    queryOne<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_refs'"
    ) !== undefined;
  db.exec(`CREATE TABLE IF NOT EXISTS message_refs (
  message_id TEXT NOT NULL, type TEXT NOT NULL, ref_id TEXT NOT NULL,
  PRIMARY KEY (message_id, type, ref_id)
);
CREATE INDEX IF NOT EXISTS message_refs_target ON message_refs (type, ref_id);`);
  if (existed) return;
  db.exec(`INSERT OR IGNORE INTO message_refs (message_id, type, ref_id)
    SELECT m.id, json_extract(j.value, '$.type'), json_extract(j.value, '$.id')
    FROM messages m, json_each(m.refs_json) j
    WHERE json_extract(j.value, '$.type') IS NOT NULL
      AND json_extract(j.value, '$.id') IS NOT NULL`);
}

/** Which messages a conversation read matches: both parties of a pair, every
 *  thread an address took part in, or every thread referencing a ref. */
export type ConversationMatch =
  | { kind: 'pair'; a: Address; b: Address }
  | { kind: 'about'; addresses: readonly Address[] }
  | { kind: 'ref'; type: string; id: string };

export interface ConversationPage {
  /** Only ids below this one (ulid order). */
  before?: string;
  limit?: number;
  /** Only thread roots. */
  rootsOnly?: boolean;
}

interface MessageRow {
  id: string;
  thread: string;
  reply_to: string | null;
  from_addr: string;
  session: string | null;
  kind: string;
  body: string;
  refs_json: string;
  data_json: string | null;
  urgent: number;
  blocking: number;
  choices_json: string | null;
  choice: string | null;
  wake: string;
  created_at: string;
  origin: string | null;
  hlc: string | null;
  received_at: string | null;
  settled_as: string | null;
}
interface DeliveryRow {
  id: string;
  message_id: string;
  recipient: string;
  run_id: string | null;
  via: string;
  state: string;
  updated_at: string;
}
interface RemoteRow {
  message_id: string;
  recipient: string;
  via: string;
  state: string;
  homes_json: string;
  wake_at: string | null;
  refused_by: string | null;
  updated_at: string;
}
interface SettlementRow {
  question_id: string;
  answer_id: string | null;
  closed_reason: string | null;
  settler: string;
  at: string;
}
interface AgentRow {
  addr: string;
  display_name: string;
  client: string;
  token_hash: string;
  status: string;
  muted: number;
  approved_by: string | null;
  created_at: string;
}

function oneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  what: string
): T {
  if (!(allowed as readonly string[]).includes(value))
    throw new Error(`messages.db: bad ${what} ${JSON.stringify(value)}`);
  return value as T;
}

export class SqliteMessageStore implements MessageStore {
  private depth = 0;

  constructor(private readonly db: SqliteDatabase) {}

  // Re-entrant: only the outermost call issues BEGIN/COMMIT.
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN');
    this.depth++;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth--;
    }
  }

  insertMessage(m: Message, idemKey?: string, meta?: StoredMeta): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO messages (id, thread, reply_to, from_addr, session, kind, body, refs_json, data_json, urgent, blocking, choices_json, choice, wake, created_at, idem_key, origin, hlc, received_at, settled_as) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          m.id,
          m.thread,
          m.replyTo,
          m.from,
          m.session ?? null,
          m.kind,
          m.body,
          JSON.stringify(m.refs),
          m.data === undefined ? null : JSON.stringify(m.data),
          m.urgent ? 1 : 0,
          m.blocking ? 1 : 0,
          m.choices === undefined ? null : JSON.stringify(m.choices),
          m.choice ?? null,
          m.wake,
          m.createdAt,
          idemKey ?? null,
          m.origin ?? null,
          m.hlc ?? null,
          meta?.receivedAt ?? null,
          meta?.settledAs ?? null
        );
      const insert = this.db.prepare(
        'INSERT INTO recipients (message_id, position, addr) VALUES (?,?,?)'
      );
      m.to.forEach((addr, i) => insert.run(m.id, i, addr));
      const ref = this.db.prepare(
        'INSERT OR IGNORE INTO message_refs (message_id, type, ref_id) VALUES (?,?,?)'
      );
      for (const r of m.refs) ref.run(m.id, r.type, r.id);
    });
  }

  private toMessage(row: MessageRow): Message {
    const to = queryAll<{ addr: string }>(
      this.db,
      'SELECT addr FROM recipients WHERE message_id = ? ORDER BY position',
      [row.id]
    ).map((r) => r.addr);
    const message: Message = {
      id: row.id,
      thread: row.thread,
      replyTo: row.reply_to,
      from: row.from_addr,
      to,
      kind: row.kind as Message['kind'],
      body: row.body,
      refs: JSON.parse(row.refs_json) as Ref[],
      urgent: row.urgent === 1,
      blocking: row.blocking === 1,
      wake: oneOf(row.wake, ['none', 'request'] as const, 'wake'),
      createdAt: row.created_at,
    };
    if (row.session !== null) message.session = row.session;
    if (row.data_json !== null)
      message.data = JSON.parse(row.data_json) as JsonValue;
    if (row.choices_json !== null)
      message.choices = JSON.parse(row.choices_json) as string[];
    if (row.choice !== null) message.choice = row.choice;
    if (row.origin !== null) message.origin = row.origin;
    if (row.hlc !== null) message.hlc = row.hlc;
    return message;
  }

  getMessage(id: string): Message | null {
    const row = queryOne<MessageRow>(
      this.db,
      'SELECT * FROM messages WHERE id = ?',
      [id]
    );
    return row === undefined ? null : this.toMessage(row);
  }

  byIdemKey(from: Address, key: string): Message | null {
    const row = queryOne<MessageRow>(
      this.db,
      'SELECT * FROM messages WHERE from_addr = ? AND idem_key = ?',
      [from, key]
    );
    return row === undefined ? null : this.toMessage(row);
  }

  // Chunked so a long history never exceeds SQLite's bound-parameter limit.
  idemKeysFor(messageIds: string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (let i = 0; i < messageIds.length; i += 500) {
      const chunk = messageIds.slice(i, i + 500);
      const rows = queryAll<{ id: string; idem_key: string }>(
        this.db,
        `SELECT id, idem_key FROM messages WHERE idem_key IS NOT NULL AND id IN (${chunk.map(() => '?').join(',')})`,
        chunk
      );
      for (const r of rows) out.set(r.id, r.idem_key);
    }
    return out;
  }

  messagesFrom(
    address: Address,
    sinceIso: string,
    kinds?: MessageKind[]
  ): Message[] {
    const byKind =
      kinds === undefined
        ? ''
        : ` AND kind IN (${kinds.map(() => '?').join(',')})`;
    return queryAll<MessageRow>(
      this.db,
      `SELECT * FROM messages WHERE from_addr = ? AND created_at >= ?${byKind} ORDER BY id`,
      [address, sinceIso, ...(kinds ?? [])]
    ).map((r) => this.toMessage(r));
  }

  // Pre-federation rows have no clock and sort first; after that a reply
  // always follows its question, whatever the machines' wall clocks say.
  thread(threadId: string): Message[] {
    return queryAll<MessageRow>(
      this.db,
      'SELECT * FROM messages WHERE thread = ? ORDER BY (hlc IS NOT NULL), hlc, id',
      [threadId]
    ).map((r) => this.toMessage(r));
  }

  answersTo(messageId: string): Message[] {
    return queryAll<MessageRow>(
      this.db,
      "SELECT * FROM messages WHERE reply_to = ? AND kind = 'answer' ORDER BY id",
      [messageId]
    ).map((r) => this.toMessage(r));
  }

  openBlocking(): Message[] {
    return queryAll<MessageRow>(
      this.db,
      "SELECT m.* FROM messages m WHERE m.blocking = 1 AND NOT EXISTS (SELECT 1 FROM messages a WHERE a.reply_to = m.id AND a.kind = 'answer') ORDER BY m.id"
    ).map((r) => this.toMessage(r));
  }

  insertDelivery(d: Delivery): void {
    this.db
      .prepare(
        'INSERT INTO deliveries (id, message_id, recipient, run_id, via, state, updated_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(
        d.id,
        d.messageId,
        d.recipient,
        d.runId,
        d.via,
        d.state,
        d.updatedAt
      );
  }

  deleteDelivery(id: string): boolean {
    return (
      Number(
        this.db.prepare('DELETE FROM deliveries WHERE id = ?').run(id).changes
      ) > 0
    );
  }

  private toDelivery(r: DeliveryRow): Delivery {
    return {
      id: r.id,
      messageId: r.message_id,
      recipient: r.recipient,
      runId: r.run_id,
      via: oneOf<DeliveryVia>(r.via, ['direct', 'channel'], 'via'),
      state: oneOf<DeliveryState>(r.state, DELIVERY_STATES, 'state'),
      updatedAt: r.updated_at,
    };
  }

  getDelivery(id: string): Delivery | null {
    const row = queryOne<DeliveryRow>(
      this.db,
      'SELECT * FROM deliveries WHERE id = ?',
      [id]
    );
    return row === undefined ? null : this.toDelivery(row);
  }

  deliveries(filter: DeliveryFilter): Delivery[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.recipient !== undefined) {
      where.push('recipient = ?');
      params.push(filter.recipient);
    }
    if (filter.runId !== undefined) {
      where.push('run_id = ?');
      params.push(filter.runId);
    }
    if (filter.recipientPrefix !== undefined) {
      where.push("recipient LIKE ? ESCAPE '\\'");
      params.push(`${filter.recipientPrefix.replace(/[\\%_]/g, '\\$&')}%`);
    }
    if (filter.messageId !== undefined) {
      where.push('message_id = ?');
      params.push(filter.messageId);
    }
    if (filter.states !== undefined) {
      const placeholders = filter.states.map(() => '?').join(',');
      where.push(`state IN (${placeholders.length > 0 ? placeholders : "''"})`);
      params.push(...filter.states);
    }
    const sql = `SELECT * FROM deliveries${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id`;
    return queryAll<DeliveryRow>(this.db, sql, params).map((r) =>
      this.toDelivery(r)
    );
  }

  setDelivery(
    id: string,
    state: DeliveryState,
    runId: string | null,
    at: string,
    expected?: DeliveryState
  ): boolean {
    const result =
      expected === undefined
        ? this.db
            .prepare(
              'UPDATE deliveries SET state = ?, run_id = ?, updated_at = ? WHERE id = ?'
            )
            .run(state, runId, at, id)
        : this.db
            .prepare(
              'UPDATE deliveries SET state = ?, run_id = ?, updated_at = ? WHERE id = ? AND state = ?'
            )
            .run(state, runId, at, id, expected);
    return Number(result.changes) > 0;
  }

  markGateApplied(questionId: string, at: string): void {
    this.db
      .prepare(
        'INSERT INTO gate_effects (question_id, applied_at) VALUES (?,?) ON CONFLICT (question_id) DO NOTHING'
      )
      .run(questionId, at);
  }

  // Voids by kind, so the one-answer index frees and the question reopens; an
  // older build that ignores the table still reads the row as a plain message.
  voidAnswer(answerId: string, questionId: string, at: string): boolean {
    return this.transaction(() => {
      const changed = this.db
        .prepare(
          "UPDATE messages SET kind = 'message' WHERE id = ? AND reply_to = ? AND kind = 'answer'"
        )
        .run(answerId, questionId);
      if (Number(changed.changes) === 0) return false;
      this.db
        .prepare(
          'INSERT INTO voided_answers (answer_id, question_id, at) VALUES (?,?,?) ON CONFLICT (answer_id) DO NOTHING'
        )
        .run(answerId, questionId, at);
      return true;
    });
  }

  // SQL narrows to answered questions with gate data and no recorded effect;
  // the engine keeps the types it implements, and system closes are dropped.
  unappliedAnsweredGates(): { question: Message; answer: Message }[] {
    const rows = queryAll<{ question_id: string; answer_id: string }>(
      this.db,
      `SELECT q.id AS question_id, a.id AS answer_id FROM messages q
       JOIN messages a ON a.reply_to = q.id AND a.kind = 'answer'
       WHERE q.data_json LIKE '%"type":%'
       AND NOT EXISTS (SELECT 1 FROM gate_effects g WHERE g.question_id = q.id)
       ORDER BY q.id`
    );
    return rows.flatMap((r) => {
      const question = this.getMessage(r.question_id);
      const answer = this.getMessage(r.answer_id);
      if (question === null || answer === null || !hasGateData(question))
        return [];
      return isSystemMarker(answer, 'x-closed') ? [] : [{ question, answer }];
    });
  }

  // Counts by arrival, so a remote sender cannot dodge a quota by backdating createdAt.
  countFrom(
    from: Address,
    sinceIso: string,
    urgentOnly: boolean,
    origin?: string,
    untilIso?: string
  ): number {
    const row = queryOne<{ n: number }>(
      this.db,
      `SELECT COUNT(*) AS n FROM messages WHERE from_addr = ? AND COALESCE(received_at, created_at) >= ? AND COALESCE(received_at, created_at) <= ?${urgentOnly ? ' AND urgent = 1' : ''}${origin === undefined ? '' : ' AND origin = ?'}`,
      origin === undefined
        ? [from, sinceIso, untilIso ?? '9999']
        : [from, sinceIso, untilIso ?? '9999', origin]
    );
    return row === undefined ? 0 : Number(row.n);
  }

  countDeliveredTo(
    recipient: Address,
    sinceIso: string,
    untilIso?: string
  ): number {
    const row = queryOne<{ n: number }>(
      this.db,
      'SELECT COUNT(DISTINCT m.id) AS n FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.recipient = ? AND m.created_at >= ? AND m.created_at <= ?',
      [recipient, sinceIso, untilIso ?? '9999']
    );
    return row === undefined ? 0 : Number(row.n);
  }

  countAgentThreadsFrom(from: Address, sinceIso: string): number {
    const row = queryOne<{ n: number }>(
      this.db,
      "SELECT COUNT(*) AS n FROM messages m WHERE m.from_addr = ? AND m.thread = m.id AND COALESCE(m.received_at, m.created_at) >= ? AND EXISTS (SELECT 1 FROM recipients r WHERE r.message_id = m.id AND (r.addr LIKE 'agent:%' OR r.addr LIKE 'run:%' OR r.addr LIKE 'task:%')) AND NOT EXISTS (SELECT 1 FROM recipients r WHERE r.message_id = m.id AND r.addr LIKE 'human:%') AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.recipient LIKE 'human:%')",
      [from, sinceIso]
    );
    return row === undefined ? 0 : Number(row.n);
  }

  // A remote agent:dispatch is an ordinary agent here, so only the local
  // system address is excluded.
  countAgentAuthored(
    threadId: string,
    sinceIso: string,
    exclude: Address
  ): number {
    const row = queryOne<{ n: number }>(
      this.db,
      "SELECT COUNT(*) AS n FROM messages WHERE thread = ? AND COALESCE(received_at, created_at) >= ? AND (from_addr != ? OR origin IS NOT NULL) AND (from_addr LIKE 'run:%' OR from_addr LIKE 'agent:%' OR from_addr LIKE 'a2a:%')",
      [threadId, sinceIso, exclude]
    );
    return row === undefined ? 0 : Number(row.n);
  }

  settledAs(messageId: string): SettledAs | null {
    const row = queryOne<{ settled_as: string | null }>(
      this.db,
      'SELECT settled_as FROM messages WHERE id = ?',
      [messageId]
    );
    return row === undefined || row.settled_as === null
      ? null
      : oneOf(row.settled_as, SETTLED_AS, 'settled_as');
  }

  setSettled(
    messageId: string,
    kind: 'answer' | 'message',
    settledAs: SettledAs | null
  ): void {
    this.db
      .prepare('UPDATE messages SET kind = ?, settled_as = ? WHERE id = ?')
      .run(kind, settledAs, messageId);
  }

  answerCandidates(
    questionId: string
  ): { message: Message; settledAs: SettledAs | null }[] {
    return queryAll<MessageRow>(
      this.db,
      "SELECT * FROM messages WHERE reply_to = ? AND (kind = 'answer' OR settled_as IS NOT NULL) ORDER BY rowid",
      [questionId]
    ).map((r) => ({
      message: this.toMessage(r),
      settledAs:
        r.settled_as === null
          ? null
          : oneOf(r.settled_as, SETTLED_AS, 'settled_as'),
    }));
  }

  insertRemote(row: RemoteDelivery): boolean {
    const result = this.db
      .prepare(
        'INSERT INTO remote_deliveries (message_id, recipient, via, state, homes_json, wake_at, refused_by, updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (message_id, recipient) DO NOTHING'
      )
      .run(
        row.messageId,
        row.recipient,
        row.via,
        row.state,
        JSON.stringify(row.homes),
        row.wakeAt,
        JSON.stringify(row.refusedBy),
        row.updatedAt
      );
    return Number(result.changes) > 0;
  }

  private toRemote(r: RemoteRow): RemoteDelivery {
    return {
      messageId: r.message_id,
      recipient: r.recipient,
      via: oneOf<DeliveryVia>(r.via, ['direct', 'channel'], 'via'),
      state: oneOf(r.state, REMOTE_STATES, 'remote state'),
      homes: JSON.parse(r.homes_json) as string[],
      wakeAt: r.wake_at,
      refusedBy:
        r.refused_by === null ? [] : (JSON.parse(r.refused_by) as string[]),
      updatedAt: r.updated_at,
    };
  }

  remoteDeliveries(filter: {
    messageId?: string;
    recipient?: Address;
    states?: RemoteState[];
  }): RemoteDelivery[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.messageId !== undefined) {
      where.push('message_id = ?');
      params.push(filter.messageId);
    }
    if (filter.recipient !== undefined) {
      where.push('recipient = ?');
      params.push(filter.recipient);
    }
    if (filter.states !== undefined) {
      const placeholders = filter.states.map(() => '?').join(',');
      where.push(`state IN (${placeholders.length > 0 ? placeholders : "''"})`);
      params.push(...filter.states);
    }
    const sql = `SELECT * FROM remote_deliveries${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY message_id, recipient`;
    return queryAll<RemoteRow>(this.db, sql, params).map((r) =>
      this.toRemote(r)
    );
  }

  setRemote(
    messageId: string,
    recipient: Address,
    patch: { state?: RemoteState; refusedBy?: string[]; homes?: string[] },
    at: string,
    expected?: RemoteState
  ): boolean {
    const sets = ['updated_at = ?'];
    const params: SqlValue[] = [at];
    if (patch.state !== undefined) {
      sets.push('state = ?');
      params.push(patch.state);
    }
    if (patch.refusedBy !== undefined) {
      sets.push('refused_by = ?');
      params.push(JSON.stringify(patch.refusedBy));
    }
    if (patch.homes !== undefined) {
      sets.push('homes_json = ?');
      params.push(JSON.stringify(patch.homes));
    }
    params.push(messageId, recipient);
    if (expected !== undefined) params.push(expected);
    const result = this.db
      .prepare(
        `UPDATE remote_deliveries SET ${sets.join(', ')} WHERE message_id = ? AND recipient = ?${expected === undefined ? '' : ' AND state = ?'}`
      )
      .run(...params);
    return Number(result.changes) > 0;
  }

  deleteRemote(messageId: string, recipient: Address): boolean {
    return (
      Number(
        this.db
          .prepare(
            'DELETE FROM remote_deliveries WHERE message_id = ? AND recipient = ?'
          )
          .run(messageId, recipient).changes
      ) > 0
    );
  }

  settlement(questionId: string): Settlement | null {
    const row = queryOne<SettlementRow>(
      this.db,
      'SELECT * FROM settlements WHERE question_id = ?',
      [questionId]
    );
    return row === undefined ? null : toSettlement(row);
  }

  putSettlement(s: Settlement): void {
    this.db
      .prepare(
        `INSERT INTO settlements (question_id, answer_id, closed_reason, settler, at) VALUES (?,?,?,?,?)
      ON CONFLICT (question_id) DO UPDATE SET answer_id = excluded.answer_id, closed_reason = excluded.closed_reason,
      settler = excluded.settler, at = excluded.at`
      )
      .run(s.questionId, s.answerId, s.closedReason, s.settler, s.at);
  }

  putEarlySettlement(s: Settlement): void {
    this.db
      .prepare(
        `INSERT INTO early_settlements (question_id, settler, answer_id, closed_reason, at) VALUES (?,?,?,?,?)
      ON CONFLICT (question_id, settler) DO UPDATE SET answer_id = excluded.answer_id,
      closed_reason = excluded.closed_reason, at = excluded.at`
      )
      .run(s.questionId, s.settler, s.answerId, s.closedReason, s.at);
  }

  earlySettlements(questionId: string): Settlement[] {
    return queryAll<SettlementRow>(
      this.db,
      'SELECT * FROM early_settlements WHERE question_id = ? ORDER BY at, settler',
      [questionId]
    ).map(toSettlement);
  }

  clearEarlySettlements(questionId: string): void {
    this.db
      .prepare('DELETE FROM early_settlements WHERE question_id = ?')
      .run(questionId);
  }

  // The outbound scan's watermark is a rowid: messages rows are never deleted,
  // so each new row's rowid is higher than every earlier one.
  messagesAfter(
    rowid: number,
    limit: number
  ): { rowid: number; message: Message }[] {
    return queryAll<MessageRow & { rid: number }>(
      this.db,
      'SELECT rowid AS rid, * FROM messages WHERE rowid > ? AND origin IS NULL ORDER BY rowid LIMIT ?',
      [rowid, limit]
    ).map((r) => ({ rowid: Number(r.rid), message: this.toMessage(r) }));
  }

  maxRowid(): number {
    const row = queryOne<{ n: number | null }>(
      this.db,
      'SELECT MAX(rowid) AS n FROM messages'
    );
    return row === undefined || row.n === null ? 0 : Number(row.n);
  }

  ensureChannel(name: string, at: string, auto: boolean): void {
    this.db
      .prepare(
        'INSERT INTO channels (name, created_at, auto) VALUES (?,?,?) ON CONFLICT (name) DO NOTHING'
      )
      .run(name, at, auto ? 1 : 0);
  }

  channels(): ChannelRecord[] {
    return queryAll<{ name: string; created_at: string; auto: number }>(
      this.db,
      'SELECT * FROM channels ORDER BY name'
    ).map((r) => ({
      name: r.name,
      createdAt: r.created_at,
      auto: r.auto === 1,
    }));
  }

  addMember(channel: string, member: Address, at: string): boolean {
    return (
      Number(
        this.db
          .prepare(
            'INSERT INTO members (channel, addr, joined_at) VALUES (?,?,?) ON CONFLICT (channel, addr) DO NOTHING'
          )
          .run(channel, member, at).changes
      ) > 0
    );
  }

  removeMember(channel: string, member: Address): boolean {
    return (
      Number(
        this.db
          .prepare('DELETE FROM members WHERE channel = ? AND addr = ?')
          .run(channel, member).changes
      ) > 0
    );
  }

  members(channel: string): Address[] {
    return queryAll<{ addr: string }>(
      this.db,
      'SELECT addr FROM members WHERE channel = ? ORDER BY addr',
      [channel]
    ).map((r) => r.addr);
  }

  channelsOf(member: Address): string[] {
    return queryAll<{ channel: string }>(
      this.db,
      'SELECT channel FROM members WHERE addr = ? ORDER BY channel',
      [member]
    ).map((r) => r.channel);
  }

  putAgent(a: AgentRecord): void {
    this.db
      .prepare(
        `INSERT INTO agents (addr, display_name, client, token_hash, status, muted, approved_by, created_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT (addr) DO UPDATE SET display_name = excluded.display_name, client = excluded.client, token_hash = excluded.token_hash,
      status = excluded.status, muted = excluded.muted, approved_by = excluded.approved_by`
      )
      .run(
        a.address,
        a.displayName,
        a.client,
        a.tokenHash,
        a.status,
        a.muted ? 1 : 0,
        a.approvedBy,
        a.createdAt
      );
  }

  private toAgent(r: AgentRow): AgentRecord {
    return {
      address: r.addr,
      displayName: r.display_name,
      client: r.client,
      tokenHash: r.token_hash,
      status: oneOf<AgentStatus>(
        r.status,
        ['pending', 'approved', 'revoked'],
        'agent status'
      ),
      muted: r.muted === 1,
      approvedBy: r.approved_by,
      createdAt: r.created_at,
    };
  }

  getAgent(address: Address): AgentRecord | null {
    const row = queryOne<AgentRow>(
      this.db,
      'SELECT * FROM agents WHERE addr = ?',
      [address]
    );
    return row === undefined ? null : this.toAgent(row);
  }

  agentByTokenHash(hash: string): AgentRecord | null {
    const row = queryOne<AgentRow>(
      this.db,
      'SELECT * FROM agents WHERE token_hash = ?',
      [hash]
    );
    return row === undefined ? null : this.toAgent(row);
  }

  agents(): AgentRecord[] {
    return queryAll<AgentRow>(
      this.db,
      'SELECT * FROM agents ORDER BY addr'
    ).map((r) => this.toAgent(r));
  }

  // Most recently active threads by local arrival (rowid), newest first.
  // `about` keeps threads with a message from, to or delivered to one of those addresses.
  recentThreads(limit: number, about?: readonly Address[]): ThreadSummary[] {
    if (about !== undefined && about.length === 0) return [];
    const params: SqlValue[] = [];
    let where = '';
    if (about !== undefined) {
      const clause = threadsAbout(about);
      where = `WHERE thread IN (${clause.sql})`;
      params.push(...clause.params);
    }
    params.push(limit);
    const rows = queryAll<{
      thread: string;
      last_rowid: number;
      count: number;
    }>(
      this.db,
      `SELECT thread, MAX(rowid) AS last_rowid, COUNT(*) AS count
       FROM messages ${where} GROUP BY thread ORDER BY last_rowid DESC LIMIT ?`,
      params
    );
    return rows.flatMap((r) => {
      // A thread's id is its root's id; a partial thread falls back to its
      // earliest stored row, never to MIN(id) across skewed machines.
      const root = this.getMessage(r.thread) ?? this.firstStored(r.thread);
      const last = this.byRowid(Number(r.last_rowid));
      return root === null || last === null
        ? []
        : [{ thread: r.thread, root, last, count: Number(r.count) }];
    });
  }

  /** Messages a conversation read matches, newest (highest id) first. */
  conversation(match: ConversationMatch, page: ConversationPage): Message[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (match.kind === 'pair') {
      const party =
        '(m.from_addr = ? OR EXISTS (SELECT 1 FROM recipients r WHERE r.message_id = m.id AND r.addr = ?))';
      where.push(`${party} AND ${party}`);
      params.push(match.a, match.a, match.b, match.b);
    } else if (match.kind === 'about') {
      if (match.addresses.length === 0) return [];
      const clause = threadsAbout(match.addresses);
      where.push(`m.thread IN (${clause.sql})`);
      params.push(...clause.params);
    } else {
      where.push(`m.thread IN (SELECT t.thread FROM message_refs x
        JOIN messages t ON t.id = x.message_id WHERE x.type = ? AND x.ref_id = ?)`);
      params.push(match.type, match.id);
    }
    if (page.before !== undefined) {
      where.push('m.id < ?');
      params.push(page.before);
    }
    if (page.rootsOnly === true) where.push('m.id = m.thread');
    params.push(page.limit ?? 50);
    return queryAll<MessageRow>(
      this.db,
      `SELECT m.* FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT ?`,
      params
    ).map((r) => this.toMessage(r));
  }

  private firstStored(threadId: string): Message | null {
    const row = queryOne<MessageRow>(
      this.db,
      'SELECT * FROM messages WHERE thread = ? ORDER BY rowid LIMIT 1',
      [threadId]
    );
    return row === undefined ? null : this.toMessage(row);
  }

  private byRowid(rowid: number): Message | null {
    const row = queryOne<MessageRow>(
      this.db,
      'SELECT * FROM messages WHERE rowid = ?',
      [rowid]
    );
    return row === undefined ? null : this.toMessage(row);
  }
}

// Threads `about` took part in as sender, recipient or delivery recipient;
// held mail rebound to a run keeps its task recipient, so match it by run id.
function threadsAbout(about: readonly Address[]): {
  sql: string;
  params: SqlValue[];
} {
  const marks = about.map(() => '?').join(', ');
  const runIds = about
    .filter((a) => a.startsWith('run:'))
    .map((a) => a.slice('run:'.length));
  const byRun =
    runIds.length === 0
      ? ''
      : ` OR d.run_id IN (${runIds.map(() => '?').join(', ')})`;
  return {
    sql: `SELECT thread FROM messages WHERE from_addr IN (${marks})
        UNION SELECT m.thread FROM messages m JOIN recipients r ON r.message_id = m.id WHERE r.addr IN (${marks})
        UNION SELECT m.thread FROM messages m JOIN deliveries d ON d.message_id = m.id
          WHERE d.recipient IN (${marks})${byRun}`,
    params: [...about, ...about, ...about, ...runIds],
  };
}

function toSettlement(r: SettlementRow): Settlement {
  return {
    questionId: r.question_id,
    answerId: r.answer_id,
    closedReason: r.closed_reason,
    settler: r.settler,
    at: r.at,
  };
}
