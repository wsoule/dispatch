import { dbVersion, openSqliteDb, queryAll, queryOne } from '@dispatch/core';
import type { SqliteDatabase, SqlValue } from '@dispatch/core';
import type { Address } from '@dispatch/protocol';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { TaskStateName } from '../states.js';
import { TERMINAL_STATES } from '../states.js';

export const A2A_DB_VERSION = 1;

export interface ClientRow {
  address: Address;
  name: string;
  recipients: Address[];
  createdBy: Address;
  createdAt: string;
}

export interface TaskRow {
  id: string;
  client: Address;
  contextId: string;
  skill: 'ask' | 'handoff';
  dispatchTask: string | null;
  gate: string | null;
  state: TaskStateName;
  statusAt: string;
  canceledAt: string | null;
  declinedAt: string | null;
  createdAt: string;
}

export type TaskPatch = Partial<
  Pick<
    TaskRow,
    'state' | 'statusAt' | 'canceledAt' | 'declinedAt' | 'dispatchTask' | 'gate'
  >
>;

export interface TaskListQuery {
  client: Address;
  contextId?: string;
  state?: TaskStateName;
  after?: string;
  limit: number;
  cursor?: { statusAt: string; id: string };
}

export type PeerStatus = 'active' | 'disabled' | 'auth-failed';

// An outbound peer as registered; its credential lives in credentials.json.
export interface PeerRow {
  alias: string;
  cardUrl: string;
  interfaceUrl: string;
  binding: 'HTTP+JSON' | 'JSONRPC';
  cardJson: string;
  etag: string | null;
  fetchedAt: string;
  status: PeerStatus;
  addedBy: Address;
  addedTier: 'decide' | 'operator';
  allowHttp: boolean;
  allowOrigin: boolean;
  apiKeyHeader: string | null;
  createdAt: string;
}

export type OutboundState = 'queued' | 'open' | 'done' | 'failed';

// One Dispatch message relayed to one peer: its retry state and, once sent,
// the peer task the worker follows.
export interface OutboundRow {
  messageId: string;
  alias: string;
  thread: string;
  remoteTaskId: string | null;
  remoteContextId: string | null;
  state: OutboundState;
  attempts: number;
  firstAttemptAt: string;
  nextAttemptAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

// A client's push config on one of its tasks; token and credentials are
// secrets a client handed us to send back, so a2a.db must hold them.
export interface PushConfigRow {
  id: string;
  taskId: string;
  client: Address;
  url: string;
  token: string | null;
  authScheme: string | null;
  authCredentials: string | null;
  failures: number;
  disabledAt: string | null;
  createdAt: string;
}

// An operator-issued credential for one standalone host; the token is kept
// only as its sha256.
export interface HostRow {
  id: string;
  name: string;
  tokenHash: string;
  // The URL the host serves on, pinned at minting; its card uses no other.
  publicUrl: string;
  createdBy: Address;
  createdAt: string;
  revokedAt: string | null;
}

// The bridge's own records: registered clients, the A2A tasks they opened,
// the outbound peers and what was relayed to them, and push configs.
export interface A2AStore {
  putClient(row: ClientRow): void;
  getClient(address: Address): ClientRow | null;
  clients(): ClientRow[];
  // False when a task with this id already exists.
  insertTask(row: TaskRow): boolean;
  getTask(id: string): TaskRow | null;
  updateTask(id: string, patch: TaskPatch): void;
  // Newest status first (status_at DESC, id DESC); total ignores the cursor.
  listTasks(q: TaskListQuery): { rows: TaskRow[]; total: number };
  tasksOf(client: Address): TaskRow[];
  // Every task whose state is not terminal.
  openTasks(): TaskRow[];
  countOpen(client: Address): number;
  // Rows created in [sinceIso, untilIso]; a row dated past `untilIso` (a
  // clock that jumped) is outside the window.
  countSince(
    client: Address,
    skill: 'ask' | 'handoff',
    sinceIso: string,
    untilIso?: string
  ): number;
  newestTaskAt(client: Address): string | null;
  taskForDispatchTask(taskId: string): TaskRow | null;
  // Upsert by alias; added_by, added_tier and created_at keep their first values.
  putPeer(row: PeerRow): void;
  getPeer(alias: string): PeerRow | null;
  // By alias.
  peers(): PeerRow[];
  setPeerStatus(alias: string, status: PeerStatus): void;
  deletePeer(alias: string): boolean;
  // Upsert on (message_id, alias); thread and first_attempt_at keep their first values.
  putOutbound(row: OutboundRow): void;
  getOutbound(messageId: string, alias: string): OutboundRow | null;
  // Oldest update first.
  outboundIn(states: OutboundState[]): OutboundRow[];
  outboundOf(alias: string, states: OutboundState[]): OutboundRow[];
  // The peer's context for this thread, from the newest row that has one.
  contextFor(alias: string, thread: string): string | null;
  // Open or done rows first attempted since `sinceIso`: the channel quota.
  relayedSince(alias: string, sinceIso: string): number;
  // Upsert on (task_id, id).
  putPushConfig(row: PushConfigRow): void;
  getPushConfig(taskId: string, id: string): PushConfigRow | null;
  // Enabled configs only, oldest first.
  pushConfigsOf(taskId: string): PushConfigRow[];
  // Enabled configs on the client's unfinished tasks only.
  countPushConfigs(client: Address): number;
  deletePushConfig(taskId: string, id: string): boolean;
  // Every config of one client (a revoked one); returns how many.
  deletePushConfigsOf(client: Address): number;
  // A success resets the failure count; a failure adds one and disables the
  // config at `disableAt` in a row. Null when the config is gone.
  recordPushResult(
    taskId: string,
    id: string,
    ok: boolean,
    at: string,
    disableAt?: number
  ): PushConfigRow | null;
  // Disables a config at once (a refused address). Disabling, here or at ten
  // failures, also drops the config's token and credentials.
  disablePushConfig(taskId: string, id: string, at: string): void;
  putHost(row: HostRow): void;
  // Oldest first, revoked rows included.
  hosts(): HostRow[];
  hostByTokenHash(hash: string): HostRow | null;
  // True when a live host was revoked.
  revokeHost(id: string, at: string): boolean;
  close(): void;
}

// Later phases append tables here with IF NOT EXISTS; the version stays 1.
const DDL = `
CREATE TABLE IF NOT EXISTS clients (
  addr TEXT PRIMARY KEY, name TEXT NOT NULL, recipients_json TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, client TEXT NOT NULL, context_id TEXT NOT NULL, skill TEXT NOT NULL,
  dispatch_task TEXT, gate TEXT, state TEXT NOT NULL, status_at TEXT NOT NULL,
  canceled_at TEXT, declined_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_client ON tasks (client, status_at, id);
CREATE INDEX IF NOT EXISTS tasks_dispatch ON tasks (dispatch_task);
CREATE TABLE IF NOT EXISTS peers (
  alias TEXT PRIMARY KEY, card_url TEXT NOT NULL, interface_url TEXT NOT NULL, binding TEXT NOT NULL,
  card_json TEXT NOT NULL, etag TEXT, fetched_at TEXT NOT NULL, status TEXT NOT NULL,
  added_by TEXT NOT NULL, added_tier TEXT NOT NULL, allow_http INTEGER NOT NULL, allow_origin INTEGER NOT NULL,
  api_key_header TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbound (
  message_id TEXT NOT NULL, alias TEXT NOT NULL, thread TEXT NOT NULL,
  remote_task_id TEXT, remote_context_id TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL,
  first_attempt_at TEXT NOT NULL, next_attempt_at TEXT, last_error TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (message_id, alias)
);
CREATE INDEX IF NOT EXISTS outbound_state ON outbound (state, alias);
CREATE INDEX IF NOT EXISTS outbound_thread ON outbound (alias, thread, updated_at);
CREATE TABLE IF NOT EXISTS push_configs (
  id TEXT NOT NULL, task_id TEXT NOT NULL, client TEXT NOT NULL, url TEXT NOT NULL, token TEXT,
  auth_scheme TEXT, auth_credentials TEXT, failures INTEGER NOT NULL, disabled_at TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, id)
);
CREATE INDEX IF NOT EXISTS push_client ON push_configs (client);
CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, public_url TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
);
`;

// Created 0600 before SQLite opens it, so it never exists world-readable;
// refuses a file a newer schema wrote rather than stamping it back down.
export function openA2ADb(path: string): SqliteDatabase {
  if (path !== ':memory:' && !existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '', { mode: 0o600 });
  }
  const db = openSqliteDb(path);
  const existing = dbVersion(db);
  if (existing > A2A_DB_VERSION) {
    db.close();
    throw new Error(
      `a2a database at ${path} was written by a newer schema (version ${existing}, this build understands ${A2A_DB_VERSION})`
    );
  }
  db.exec(DDL);
  db.exec(`PRAGMA user_version = ${A2A_DB_VERSION}`);
  if (path !== ':memory:') chmodSync(path, 0o600);
  return db;
}

interface ClientDbRow {
  addr: string;
  name: string;
  recipients_json: string;
  created_by: string;
  created_at: string;
}

interface TaskDbRow {
  id: string;
  client: string;
  context_id: string;
  skill: string;
  dispatch_task: string | null;
  gate: string | null;
  state: string;
  status_at: string;
  canceled_at: string | null;
  declined_at: string | null;
  created_at: string;
}

interface PeerDbRow {
  alias: string;
  card_url: string;
  interface_url: string;
  binding: string;
  card_json: string;
  etag: string | null;
  fetched_at: string;
  status: string;
  added_by: string;
  added_tier: string;
  allow_http: number;
  allow_origin: number;
  api_key_header: string | null;
  created_at: string;
}

const PEER_STATUSES: readonly PeerStatus[] = [
  'active',
  'disabled',
  'auth-failed',
];

// An unknown status reads as disabled, so a hand-edited row never sends.
function toPeer(r: PeerDbRow): PeerRow {
  return {
    alias: r.alias,
    cardUrl: r.card_url,
    interfaceUrl: r.interface_url,
    binding: r.binding === 'JSONRPC' ? 'JSONRPC' : 'HTTP+JSON',
    cardJson: r.card_json,
    etag: r.etag,
    fetchedAt: r.fetched_at,
    status: PEER_STATUSES.includes(r.status as PeerStatus)
      ? (r.status as PeerStatus)
      : 'disabled',
    addedBy: r.added_by,
    addedTier: r.added_tier === 'operator' ? 'operator' : 'decide',
    allowHttp: r.allow_http === 1,
    allowOrigin: r.allow_origin === 1,
    apiKeyHeader: r.api_key_header,
    createdAt: r.created_at,
  };
}

interface OutboundDbRow {
  message_id: string;
  alias: string;
  thread: string;
  remote_task_id: string | null;
  remote_context_id: string | null;
  state: string;
  attempts: number;
  first_attempt_at: string;
  next_attempt_at: string | null;
  last_error: string | null;
  updated_at: string;
}

const OUTBOUND_STATES: readonly OutboundState[] = [
  'queued',
  'open',
  'done',
  'failed',
];

// An unknown state reads as failed, so a hand-edited row is never sent again.
function toOutbound(r: OutboundDbRow): OutboundRow {
  return {
    messageId: r.message_id,
    alias: r.alias,
    thread: r.thread,
    remoteTaskId: r.remote_task_id,
    remoteContextId: r.remote_context_id,
    state: OUTBOUND_STATES.includes(r.state as OutboundState)
      ? (r.state as OutboundState)
      : 'failed',
    attempts: Number(r.attempts),
    firstAttemptAt: r.first_attempt_at,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
    updatedAt: r.updated_at,
  };
}

interface PushDbRow {
  id: string;
  task_id: string;
  client: string;
  url: string;
  token: string | null;
  auth_scheme: string | null;
  auth_credentials: string | null;
  failures: number;
  disabled_at: string | null;
  created_at: string;
}

function toPush(r: PushDbRow): PushConfigRow {
  return {
    id: r.id,
    taskId: r.task_id,
    client: r.client,
    url: r.url,
    token: r.token,
    authScheme: r.auth_scheme,
    authCredentials: r.auth_credentials,
    failures: Number(r.failures),
    disabledAt: r.disabled_at,
    createdAt: r.created_at,
  };
}

interface HostDbRow {
  id: string;
  name: string;
  token_hash: string;
  public_url: string;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
}

function toHost(r: HostDbRow): HostRow {
  return {
    id: r.id,
    name: r.name,
    tokenHash: r.token_hash,
    publicUrl: r.public_url,
    createdBy: r.created_by,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  };
}

const placeholders = (n: number): string =>
  n === 0 ? "''" : Array.from({ length: n }, () => '?').join(',');

const TERMINAL_SQL = [...TERMINAL_STATES].map((s) => `'${s}'`).join(',');
const PATCH_COLUMNS: Record<keyof TaskPatch, string> = {
  state: 'state',
  statusAt: 'status_at',
  canceledAt: 'canceled_at',
  declinedAt: 'declined_at',
  dispatchTask: 'dispatch_task',
  gate: 'gate',
};

function toClient(r: ClientDbRow): ClientRow {
  return {
    address: r.addr,
    name: r.name,
    recipients: JSON.parse(r.recipients_json) as Address[],
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function toTask(r: TaskDbRow): TaskRow {
  return {
    id: r.id,
    client: r.client,
    contextId: r.context_id,
    skill: r.skill === 'handoff' ? 'handoff' : 'ask',
    dispatchTask: r.dispatch_task,
    gate: r.gate,
    state: r.state as TaskStateName,
    statusAt: r.status_at,
    canceledAt: r.canceled_at,
    declinedAt: r.declined_at,
    createdAt: r.created_at,
  };
}

export class SqliteA2AStore implements A2AStore {
  constructor(private readonly db: SqliteDatabase) {}

  putClient(c: ClientRow): void {
    this.db
      .prepare(
        `INSERT INTO clients (addr, name, recipients_json, created_by, created_at) VALUES (?,?,?,?,?)
         ON CONFLICT (addr) DO UPDATE SET name = excluded.name, recipients_json = excluded.recipients_json`
      )
      .run(
        c.address,
        c.name,
        JSON.stringify(c.recipients),
        c.createdBy,
        c.createdAt
      );
  }

  getClient(address: Address): ClientRow | null {
    const r = queryOne<ClientDbRow>(
      this.db,
      'SELECT * FROM clients WHERE addr = ?',
      [address]
    );
    return r === undefined ? null : toClient(r);
  }

  clients(): ClientRow[] {
    return queryAll<ClientDbRow>(
      this.db,
      'SELECT * FROM clients ORDER BY addr'
    ).map(toClient);
  }

  insertTask(t: TaskRow): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO tasks (id, client, context_id, skill, dispatch_task, gate, state, status_at, canceled_at, declined_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`
      )
      .run(
        t.id,
        t.client,
        t.contextId,
        t.skill,
        t.dispatchTask,
        t.gate,
        t.state,
        t.statusAt,
        t.canceledAt,
        t.declinedAt,
        t.createdAt
      );
    return Number(result.changes) > 0;
  }

  getTask(id: string): TaskRow | null {
    const r = queryOne<TaskDbRow>(this.db, 'SELECT * FROM tasks WHERE id = ?', [
      id,
    ]);
    return r === undefined ? null : toTask(r);
  }

  // Writes only the fields the patch sets; an explicit null clears a column.
  updateTask(id: string, patch: TaskPatch): void {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    for (const key of Object.keys(PATCH_COLUMNS) as (keyof TaskPatch)[]) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${PATCH_COLUMNS[key]} = ?`);
      params.push(value);
    }
    if (sets.length === 0) return;
    this.db
      .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params, id);
  }

  // The (status_at, id) cursor keeps rows that share a status_at in one order.
  listTasks(q: TaskListQuery): { rows: TaskRow[]; total: number } {
    const where = ['client = ?'];
    const params: SqlValue[] = [q.client];
    if (q.contextId !== undefined) {
      where.push('context_id = ?');
      params.push(q.contextId);
    }
    if (q.state !== undefined) {
      where.push('state = ?');
      params.push(q.state);
    }
    if (q.after !== undefined) {
      where.push('status_at > ?');
      params.push(q.after);
    }
    const total = Number(
      queryOne<{ n: number }>(
        this.db,
        `SELECT COUNT(*) AS n FROM tasks WHERE ${where.join(' AND ')}`,
        params
      )?.n ?? 0
    );
    const pageWhere = [...where];
    const pageParams = [...params];
    if (q.cursor !== undefined) {
      pageWhere.push('(status_at < ? OR (status_at = ? AND id < ?))');
      pageParams.push(q.cursor.statusAt, q.cursor.statusAt, q.cursor.id);
    }
    const rows = queryAll<TaskDbRow>(
      this.db,
      `SELECT * FROM tasks WHERE ${pageWhere.join(' AND ')} ORDER BY status_at DESC, id DESC LIMIT ?`,
      [...pageParams, q.limit]
    ).map(toTask);
    return { rows, total };
  }

  tasksOf(client: Address): TaskRow[] {
    return queryAll<TaskDbRow>(
      this.db,
      'SELECT * FROM tasks WHERE client = ? ORDER BY id',
      [client]
    ).map(toTask);
  }

  openTasks(): TaskRow[] {
    return queryAll<TaskDbRow>(
      this.db,
      `SELECT * FROM tasks WHERE state NOT IN (${TERMINAL_SQL}) ORDER BY id`
    ).map(toTask);
  }

  countOpen(client: Address): number {
    return Number(
      queryOne<{ n: number }>(
        this.db,
        `SELECT COUNT(*) AS n FROM tasks WHERE client = ? AND state NOT IN (${TERMINAL_SQL})`,
        [client]
      )?.n ?? 0
    );
  }

  countSince(
    client: Address,
    skill: 'ask' | 'handoff',
    sinceIso: string,
    untilIso?: string
  ): number {
    return Number(
      queryOne<{ n: number }>(
        this.db,
        'SELECT COUNT(*) AS n FROM tasks WHERE client = ? AND skill = ? AND created_at >= ? AND created_at <= ?',
        [client, skill, sinceIso, untilIso ?? '9999']
      )?.n ?? 0
    );
  }

  newestTaskAt(client: Address): string | null {
    return (
      queryOne<{ at: string | null }>(
        this.db,
        'SELECT MAX(created_at) AS at FROM tasks WHERE client = ?',
        [client]
      )?.at ?? null
    );
  }

  taskForDispatchTask(taskId: string): TaskRow | null {
    const r = queryOne<TaskDbRow>(
      this.db,
      'SELECT * FROM tasks WHERE dispatch_task = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      [taskId]
    );
    return r === undefined ? null : toTask(r);
  }

  putPeer(p: PeerRow): void {
    this.db
      .prepare(
        `INSERT INTO peers (alias, card_url, interface_url, binding, card_json, etag, fetched_at, status, added_by, added_tier, allow_http, allow_origin, api_key_header, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (alias) DO UPDATE SET card_url = excluded.card_url, interface_url = excluded.interface_url, binding = excluded.binding,
           card_json = excluded.card_json, etag = excluded.etag, fetched_at = excluded.fetched_at, status = excluded.status,
           allow_http = excluded.allow_http, allow_origin = excluded.allow_origin, api_key_header = excluded.api_key_header`
      )
      .run(
        p.alias,
        p.cardUrl,
        p.interfaceUrl,
        p.binding,
        p.cardJson,
        p.etag,
        p.fetchedAt,
        p.status,
        p.addedBy,
        p.addedTier,
        p.allowHttp ? 1 : 0,
        p.allowOrigin ? 1 : 0,
        p.apiKeyHeader,
        p.createdAt
      );
  }

  getPeer(alias: string): PeerRow | null {
    const r = queryOne<PeerDbRow>(
      this.db,
      'SELECT * FROM peers WHERE alias = ?',
      [alias]
    );
    return r === undefined ? null : toPeer(r);
  }

  peers(): PeerRow[] {
    return queryAll<PeerDbRow>(
      this.db,
      'SELECT * FROM peers ORDER BY alias'
    ).map(toPeer);
  }

  setPeerStatus(alias: string, status: PeerStatus): void {
    this.db
      .prepare('UPDATE peers SET status = ? WHERE alias = ?')
      .run(status, alias);
  }

  deletePeer(alias: string): boolean {
    return (
      Number(
        this.db.prepare('DELETE FROM peers WHERE alias = ?').run(alias).changes
      ) > 0
    );
  }

  putOutbound(r: OutboundRow): void {
    this.db
      .prepare(
        `INSERT INTO outbound (message_id, alias, thread, remote_task_id, remote_context_id, state, attempts, first_attempt_at, next_attempt_at, last_error, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (message_id, alias) DO UPDATE SET remote_task_id = excluded.remote_task_id, remote_context_id = excluded.remote_context_id,
           state = excluded.state, attempts = excluded.attempts, next_attempt_at = excluded.next_attempt_at, last_error = excluded.last_error,
           updated_at = excluded.updated_at`
      )
      .run(
        r.messageId,
        r.alias,
        r.thread,
        r.remoteTaskId,
        r.remoteContextId,
        r.state,
        r.attempts,
        r.firstAttemptAt,
        r.nextAttemptAt,
        r.lastError,
        r.updatedAt
      );
  }

  getOutbound(messageId: string, alias: string): OutboundRow | null {
    const r = queryOne<OutboundDbRow>(
      this.db,
      'SELECT * FROM outbound WHERE message_id = ? AND alias = ?',
      [messageId, alias]
    );
    return r === undefined ? null : toOutbound(r);
  }

  outboundIn(states: OutboundState[]): OutboundRow[] {
    return queryAll<OutboundDbRow>(
      this.db,
      `SELECT * FROM outbound WHERE state IN (${placeholders(states.length)}) ORDER BY updated_at`,
      states
    ).map(toOutbound);
  }

  outboundOf(alias: string, states: OutboundState[]): OutboundRow[] {
    return queryAll<OutboundDbRow>(
      this.db,
      `SELECT * FROM outbound WHERE alias = ? AND state IN (${placeholders(states.length)}) ORDER BY updated_at`,
      [alias, ...states]
    ).map(toOutbound);
  }

  contextFor(alias: string, thread: string): string | null {
    return (
      queryOne<{ c: string }>(
        this.db,
        'SELECT remote_context_id AS c FROM outbound WHERE alias = ? AND thread = ? AND remote_context_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1',
        [alias, thread]
      )?.c ?? null
    );
  }

  relayedSince(alias: string, sinceIso: string): number {
    return Number(
      queryOne<{ n: number }>(
        this.db,
        "SELECT COUNT(*) AS n FROM outbound WHERE alias = ? AND state IN ('open','done') AND first_attempt_at >= ?",
        [alias, sinceIso]
      )?.n ?? 0
    );
  }

  putPushConfig(r: PushConfigRow): void {
    this.db
      .prepare(
        `INSERT INTO push_configs (id, task_id, client, url, token, auth_scheme, auth_credentials, failures, disabled_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (task_id, id) DO UPDATE SET client = excluded.client, url = excluded.url, token = excluded.token,
           auth_scheme = excluded.auth_scheme, auth_credentials = excluded.auth_credentials, failures = excluded.failures,
           disabled_at = excluded.disabled_at, created_at = excluded.created_at`
      )
      .run(
        r.id,
        r.taskId,
        r.client,
        r.url,
        r.token,
        r.authScheme,
        r.authCredentials,
        r.failures,
        r.disabledAt,
        r.createdAt
      );
  }

  getPushConfig(taskId: string, id: string): PushConfigRow | null {
    const r = queryOne<PushDbRow>(
      this.db,
      'SELECT * FROM push_configs WHERE task_id = ? AND id = ?',
      [taskId, id]
    );
    return r === undefined ? null : toPush(r);
  }

  pushConfigsOf(taskId: string): PushConfigRow[] {
    return queryAll<PushDbRow>(
      this.db,
      'SELECT * FROM push_configs WHERE task_id = ? AND disabled_at IS NULL ORDER BY created_at, id',
      [taskId]
    ).map(toPush);
  }

  countPushConfigs(client: Address): number {
    return Number(
      queryOne<{ n: number }>(
        this.db,
        `SELECT COUNT(*) AS n FROM push_configs p JOIN tasks t ON t.id = p.task_id
         WHERE p.client = ? AND p.disabled_at IS NULL AND t.state NOT IN (${TERMINAL_SQL})`,
        [client]
      )?.n ?? 0
    );
  }

  deletePushConfig(taskId: string, id: string): boolean {
    return (
      Number(
        this.db
          .prepare('DELETE FROM push_configs WHERE task_id = ? AND id = ?')
          .run(taskId, id).changes
      ) > 0
    );
  }

  deletePushConfigsOf(client: Address): number {
    return Number(
      this.db.prepare('DELETE FROM push_configs WHERE client = ?').run(client)
        .changes
    );
  }

  recordPushResult(
    taskId: string,
    id: string,
    ok: boolean,
    at: string,
    disableAt = 10
  ): PushConfigRow | null {
    this.db
      .prepare(
        `UPDATE push_configs SET failures = CASE WHEN ? THEN 0 ELSE failures + 1 END WHERE task_id = ? AND id = ?`
      )
      .run(ok ? 1 : 0, taskId, id);
    this.db
      .prepare(
        'UPDATE push_configs SET disabled_at = ?, token = NULL, auth_credentials = NULL WHERE task_id = ? AND id = ? AND disabled_at IS NULL AND failures >= ?'
      )
      .run(at, taskId, id, disableAt);
    return this.getPushConfig(taskId, id);
  }

  disablePushConfig(taskId: string, id: string, at: string): void {
    this.db
      .prepare(
        'UPDATE push_configs SET disabled_at = ?, token = NULL, auth_credentials = NULL WHERE task_id = ? AND id = ? AND disabled_at IS NULL'
      )
      .run(at, taskId, id);
  }

  putHost(h: HostRow): void {
    this.db
      .prepare(
        'INSERT INTO hosts (id, name, token_hash, public_url, created_by, created_at, revoked_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(
        h.id,
        h.name,
        h.tokenHash,
        h.publicUrl,
        h.createdBy,
        h.createdAt,
        h.revokedAt
      );
  }

  hosts(): HostRow[] {
    return queryAll<HostDbRow>(
      this.db,
      'SELECT * FROM hosts ORDER BY created_at, id'
    ).map(toHost);
  }

  hostByTokenHash(hash: string): HostRow | null {
    const r = queryOne<HostDbRow>(
      this.db,
      'SELECT * FROM hosts WHERE token_hash = ?',
      [hash]
    );
    return r === undefined ? null : toHost(r);
  }

  revokeHost(id: string, at: string): boolean {
    return (
      Number(
        this.db
          .prepare(
            'UPDATE hosts SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'
          )
          .run(at, id).changes
      ) > 0
    );
  }

  close(): void {
    this.db.close();
  }
}
