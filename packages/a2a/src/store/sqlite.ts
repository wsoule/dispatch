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

// The bridge's own records: registered clients and the A2A tasks they opened.
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
  countSince(
    client: Address,
    skill: 'ask' | 'handoff',
    sinceIso: string
  ): number;
  newestTaskAt(client: Address): string | null;
  taskForDispatchTask(taskId: string): TaskRow | null;
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
    sinceIso: string
  ): number {
    return Number(
      queryOne<{ n: number }>(
        this.db,
        'SELECT COUNT(*) AS n FROM tasks WHERE client = ? AND skill = ? AND created_at >= ?',
        [client, skill, sinceIso]
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

  close(): void {
    this.db.close();
  }
}
