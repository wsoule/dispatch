import { dbVersion, openSqliteDb, queryAll, queryOne } from '@dispatch/core';
import type { SqliteDatabase, SqlValue } from '@dispatch/core';

import type { Address } from './address.js';
import { gateOf, isSystemMarker } from './envelope.js';
import type { JsonValue, Message, MessageKind, Ref } from './envelope.js';
import { DELIVERY_STATES } from './store.js';
import type {
  AgentRecord,
  AgentStatus,
  ChannelRecord,
  Delivery,
  DeliveryFilter,
  DeliveryState,
  DeliveryVia,
  MessageStore,
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
  return queryAll<{ name: string }>(db, 'PRAGMA table_info(messages)').some(
    (c) => c.name === 'idem_key'
  );
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

  insertMessage(m: Message, idemKey?: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO messages (id, thread, reply_to, from_addr, session, kind, body, refs_json, data_json, urgent, blocking, choices_json, choice, wake, created_at, idem_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
          idemKey ?? null
        );
      const insert = this.db.prepare(
        'INSERT INTO recipients (message_id, position, addr) VALUES (?,?,?)'
      );
      m.to.forEach((addr, i) => insert.run(m.id, i, addr));
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

  thread(threadId: string): Message[] {
    return queryAll<MessageRow>(
      this.db,
      'SELECT * FROM messages WHERE thread = ? ORDER BY id',
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

  // SQL narrows to answered questions carrying typed data with no recorded
  // effect; gateOf and the x-closed check then keep real, non-closed gates.
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
      if (question === null || answer === null || gateOf(question) === null)
        return [];
      return isSystemMarker(answer, 'x-closed') ? [] : [{ question, answer }];
    });
  }

  countFrom(from: Address, sinceIso: string, urgentOnly: boolean): number {
    const row = queryOne<{ n: number }>(
      this.db,
      `SELECT COUNT(*) AS n FROM messages WHERE from_addr = ? AND created_at >= ?${urgentOnly ? ' AND urgent = 1' : ''}`,
      [from, sinceIso]
    );
    return row === undefined ? 0 : Number(row.n);
  }

  countAgentAuthored(
    threadId: string,
    sinceIso: string,
    exclude: Address
  ): number {
    const row = queryOne<{ n: number }>(
      this.db,
      "SELECT COUNT(*) AS n FROM messages WHERE thread = ? AND created_at >= ? AND from_addr != ? AND (from_addr LIKE 'run:%' OR from_addr LIKE 'agent:%')",
      [threadId, sinceIso, exclude]
    );
    return row === undefined ? 0 : Number(row.n);
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

  addMember(channel: string, member: Address, at: string): void {
    this.db
      .prepare(
        'INSERT INTO members (channel, addr, joined_at) VALUES (?,?,?) ON CONFLICT (channel, addr) DO NOTHING'
      )
      .run(channel, member, at);
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

  // Most recently active threads, newest first (ulid ids: MIN/MAX are root and last).
  // `about` keeps threads with a message from, to or delivered to one of those addresses.
  recentThreads(limit: number, about?: readonly Address[]): ThreadSummary[] {
    if (about !== undefined && about.length === 0) return [];
    const params: SqlValue[] = [];
    let where = '';
    if (about !== undefined) {
      const marks = about.map(() => '?').join(', ');
      // Held mail rebound to a run keeps its task recipient; match it by run id.
      const runIds = about
        .filter((a) => a.startsWith('run:'))
        .map((a) => a.slice('run:'.length));
      const byRun =
        runIds.length === 0
          ? ''
          : ` OR d.run_id IN (${runIds.map(() => '?').join(', ')})`;
      where = `WHERE thread IN (
        SELECT thread FROM messages WHERE from_addr IN (${marks})
        UNION SELECT m.thread FROM messages m JOIN recipients r ON r.message_id = m.id WHERE r.addr IN (${marks})
        UNION SELECT m.thread FROM messages m JOIN deliveries d ON d.message_id = m.id
          WHERE d.recipient IN (${marks})${byRun})`;
      params.push(...about, ...about, ...about, ...runIds);
    }
    params.push(limit);
    const rows = queryAll<{
      thread: string;
      root_id: string;
      last_id: string;
      count: number;
    }>(
      this.db,
      `SELECT thread, MIN(id) AS root_id, MAX(id) AS last_id, COUNT(*) AS count
       FROM messages ${where} GROUP BY thread ORDER BY last_id DESC LIMIT ?`,
      params
    );
    return rows.flatMap((r) => {
      const root = this.getMessage(r.root_id);
      const last = this.getMessage(r.last_id);
      return root === null || last === null
        ? []
        : [{ thread: r.thread, root, last, count: Number(r.count) }];
    });
  }
}
