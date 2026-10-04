import type {
  DocProposal,
  DocScope,
  DocStatus,
  LinkRel,
  LinkTargetType,
  ProposalState,
  RevisionCause,
  SqliteDatabase,
  SqlValue,
} from '@dispatch/core';
import { dbVersion, openSqliteDb, queryAll, queryOne } from '@dispatch/core';
import { statSync } from 'node:fs';

// docs.db: every table of every stage, created at once so no later stage needs
// a migration. DOCS_DB_VERSION changes only when a column changes.
export const DOCS_DB_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY, ns TEXT NOT NULL, slug TEXT NOT NULL, handle TEXT NOT NULL,
  title TEXT NOT NULL, scope TEXT NOT NULL, owner_identity TEXT, owner_human TEXT,
  status TEXT NOT NULL, archived_from TEXT, restored_status TEXT, restored_at TEXT,
  head_id TEXT NOT NULL, reviewed_rev TEXT, unreviewed INTEGER NOT NULL,
  conflicted INTEGER NOT NULL, origin TEXT UNIQUE, published_path TEXT,
  published_rev TEXT, published_task TEXT, published_commit TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL, meta_hlc_json TEXT, indexed_hash TEXT,
  UNIQUE (ns, handle)
);
CREATE INDEX IF NOT EXISTS docs_updated ON docs (updated_at);
CREATE INDEX IF NOT EXISTS docs_created ON docs (created_by, created_at);
CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, n INTEGER, parents_json TEXT NOT NULL,
  restored_parents_json TEXT, title TEXT NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL,
  bytes INTEGER NOT NULL, author TEXT NOT NULL, cause TEXT NOT NULL, summary TEXT NOT NULL,
  approval_json TEXT, conflicted INTEGER NOT NULL, sealed INTEGER NOT NULL,
  unreviewed INTEGER NOT NULL, provisional INTEGER NOT NULL, via TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (doc_id, n)
);
CREATE INDEX IF NOT EXISTS revisions_doc ON revisions (doc_id, n);
CREATE TABLE IF NOT EXISTS reviews (
  doc_id TEXT NOT NULL, rev_id TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (doc_id, rev_id, by)
);
CREATE TABLE IF NOT EXISTS proposals (
  rev_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, base_rev TEXT NOT NULL, author TEXT NOT NULL,
  operator TEXT, run_id TEXT, task_id TEXT, origin TEXT NOT NULL, gate TEXT, state TEXT NOT NULL,
  decided_by TEXT, decided_by_policy_json TEXT, reason TEXT, result_rev TEXT,
  created_at TEXT NOT NULL, decided_at TEXT
);
CREATE INDEX IF NOT EXISTS proposals_doc ON proposals (doc_id, state);
CREATE TABLE IF NOT EXISTS sections (
  doc_id TEXT NOT NULL, ord INTEGER NOT NULL, level INTEGER NOT NULL, heading TEXT NOT NULL,
  anchor TEXT NOT NULL, start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL,
  PRIMARY KEY (doc_id, ord)
);
CREATE TABLE IF NOT EXISTS links (
  doc_id TEXT NOT NULL, doc_ns TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  rel TEXT NOT NULL, source TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, target_type, target_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS links_one_spec ON links (target_type, target_id, doc_ns) WHERE rel = 'spec';
CREATE INDEX IF NOT EXISTS links_target ON links (target_type, target_id);
CREATE TABLE IF NOT EXISTS slug_aliases (
  ns TEXT NOT NULL, slug TEXT NOT NULL, doc_id TEXT NOT NULL, retired_at TEXT NOT NULL,
  PRIMARY KEY (ns, slug, doc_id)
);
CREATE TABLE IF NOT EXISTS publishes (
  task_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, rev_id TEXT NOT NULL, path TEXT NOT NULL,
  state TEXT NOT NULL, "commit" TEXT, created_at TEXT NOT NULL, reason TEXT
);
CREATE TABLE IF NOT EXISTS assets (
  doc_id TEXT NOT NULL, name TEXT NOT NULL, bytes INTEGER NOT NULL, mime TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, checked_at TEXT,
  PRIMARY KEY (doc_id, name)
);
CREATE TABLE IF NOT EXISTS imported (
  ns TEXT NOT NULL, slug TEXT NOT NULL, hash TEXT NOT NULL, doc_id TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (ns, slug, hash)
);
CREATE TABLE IF NOT EXISTS import_sessions (
  id TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  touched_at TEXT NOT NULL, manifest_json TEXT NOT NULL, link TEXT
);
CREATE TABLE IF NOT EXISTS import_contents (
  import_id TEXT NOT NULL, hash TEXT NOT NULL, body BLOB NOT NULL, PRIMARY KEY (import_id, hash)
);
CREATE TABLE IF NOT EXISTS tombstones (
  doc_id TEXT PRIMARY KEY, ns TEXT NOT NULL, slug TEXT NOT NULL, origin TEXT,
  deleted_by TEXT NOT NULL, at TEXT NOT NULL, hlc TEXT
);
CREATE TABLE IF NOT EXISTS sync_missing (
  rev_id TEXT NOT NULL, doc_id TEXT NOT NULL, replica TEXT NOT NULL, seq INTEGER NOT NULL,
  dropped_at TEXT NOT NULL, PRIMARY KEY (rev_id, replica, seq)
);
CREATE TABLE IF NOT EXISTS linear_docs (
  doc_id TEXT PRIMARY KEY, document_id TEXT NOT NULL UNIQUE, base_rev TEXT NOT NULL,
  remote_updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const FTS_DDL =
  "CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(doc_id UNINDEXED, ord UNINDEXED, title, heading, text, tokenize = 'porter unicode61')";

// Opens (creating if needed) a docs database; refuses a newer schema. `fts`
// reports whether FTS5 is usable; `{ fts: false }` forces the LIKE fallback.
// Columns added to version-1 tables after they first shipped, added in place.
const LATER_COLUMNS: readonly { table: string; column: string; ddl: string }[] =
  [
    { table: 'publishes', column: 'reason', ddl: 'reason TEXT' },
    { table: 'publishes', column: 'idem_key', ddl: 'idem_key TEXT' },
    {
      table: 'publishes',
      column: 'dispatch_actor',
      ddl: 'dispatch_actor TEXT',
    },
    {
      table: 'publishes',
      column: 'dispatch_operator',
      ddl: 'dispatch_operator TEXT',
    },
    { table: 'assets', column: 'checked_at', ddl: 'checked_at TEXT' },
  ];

function addMissingColumns(db: SqliteDatabase): void {
  for (const { table, column, ddl } of LATER_COLUMNS) {
    const has = queryAll<{ name: string }>(
      db,
      `PRAGMA table_info(${table})`
    ).some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function openDocsDb(
  path: string,
  opts: { fts?: boolean } = {}
): { db: SqliteDatabase; fts: boolean } {
  const db = openSqliteDb(path);
  try {
    // No synchronous wait at all: a locked write fails at once and the routes
    // retry it asynchronously, so parallel writes never queue on the loop.
    db.exec('PRAGMA busy_timeout = 0');
    const existing = dbVersion(db);
    if (existing > DOCS_DB_VERSION) {
      throw new Error(
        `docs database at ${path} was written by a newer schema (version ${existing}, this build understands ${DOCS_DB_VERSION})`
      );
    }
    db.exec(DDL);
    addMissingColumns(db);
    let fts = opts.fts !== false;
    if (fts) {
      try {
        db.exec(FTS_DDL);
      } catch {
        fts = false;
      }
    }
    db.exec(`PRAGMA user_version = ${DOCS_DB_VERSION}`);
    return { db, fts };
  } catch (err) {
    db.close();
    throw err;
  }
}

export interface DocRow {
  id: string;
  ns: string;
  slug: string;
  handle: string;
  title: string;
  scope: DocScope;
  ownerIdentity: string | null;
  ownerHuman: string | null;
  status: DocStatus;
  archivedFrom: 'draft' | 'accepted' | null;
  restoredStatus: DocStatus | null;
  restoredAt: string | null;
  headId: string;
  reviewedRev: string | null;
  unreviewed: boolean;
  conflicted: boolean;
  origin: string | null;
  publishedPath: string | null;
  publishedRev: string | null;
  publishedTask: string | null;
  publishedCommit: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  indexedHash: string | null;
}

// A doc's link to the Linear document it syncs with (v2).
export interface LinearDocRow {
  docId: string;
  documentId: string;
  baseRev: string;
  remoteUpdatedAt: string;
}

interface RawLinearDoc {
  doc_id: string;
  document_id: string;
  base_rev: string;
  remote_updated_at: string;
}

const toLinearDoc = (r: RawLinearDoc): LinearDocRow => ({
  docId: r.doc_id,
  documentId: r.document_id,
  baseRev: r.base_rev,
  remoteUpdatedAt: r.remote_updated_at,
});

// One image stored for a doc; its file is docs-assets/<doc>/<name>.
export interface AssetRow {
  doc: string;
  name: string;
  bytes: number;
  mime: string;
  createdBy: string;
  createdAt: string;
}

// One publish of a doc to the repo: the task it runs as and how it ended.
export interface PublishRow {
  task: string;
  doc: string;
  rev: string;
  path: string;
  // `pending` is written before the task exists, keyed `pending:<nonce>`.
  state: 'pending' | 'open' | 'landed' | 'dropped' | 'failed';
  commit: string | null;
  createdAt: string;
  // Why a publish failed; null otherwise.
  reason: string | null;
  // The Idempotency-Key the publish was asked with, kept across restarts.
  idemKey?: string | null;
  // Who its run starts as; null when the caller asked for no run.
  dispatchAs?: { actor: string; operator: string | null } | null;
}

export interface RevisionRow {
  id: string;
  docId: string;
  n: number | null;
  parents: string[];
  restoredParents: string[] | null;
  title: string;
  body: string;
  hash: string;
  bytes: number;
  author: string;
  cause: RevisionCause;
  summary: string;
  approval: { by: string; policy?: { rung: number } } | null;
  conflicted: boolean;
  sealed: boolean;
  unreviewed: boolean;
  provisional: boolean;
  via: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RevisionMeta = Omit<RevisionRow, 'body'>;

export interface LinkRow {
  docId: string;
  docNs: string;
  targetType: LinkTargetType;
  targetId: string;
  rel: LinkRel;
  source: 'manual' | 'mention';
  createdBy: string;
  createdAt: string;
}

export interface SectionRow {
  ord: number;
  level: number;
  heading: string;
  anchor: string;
  startByte: number;
  endByte: number;
  text: string; // the section's own text; feeds FTS only
}

export interface DocListFilter {
  ns: readonly string[];
  statuses: readonly DocStatus[];
  unreviewed?: boolean;
  conflicted?: boolean;
  ids?: readonly string[];
  query?: string; // a case-insensitive title substring
  limit: number;
  offset: number;
}

export interface SearchRow {
  docId: string;
  ord: number;
  heading: string;
  anchor: string;
  snippet: string;
  score: number;
}

interface RawDoc {
  id: string;
  ns: string;
  slug: string;
  handle: string;
  title: string;
  scope: string;
  owner_identity: string | null;
  owner_human: string | null;
  status: string;
  archived_from: string | null;
  restored_status: string | null;
  restored_at: string | null;
  head_id: string;
  reviewed_rev: string | null;
  unreviewed: number;
  conflicted: number;
  origin: string | null;
  published_path: string | null;
  published_rev: string | null;
  published_task: string | null;
  published_commit: string | null;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
  indexed_hash: string | null;
}

interface RawRevision {
  id: string;
  doc_id: string;
  n: number | null;
  parents_json: string;
  restored_parents_json: string | null;
  title: string;
  body?: string;
  hash: string;
  bytes: number;
  author: string;
  cause: string;
  summary: string;
  approval_json: string | null;
  conflicted: number;
  sealed: number;
  unreviewed: number;
  provisional: number;
  via: string | null;
  created_at: string;
  updated_at: string;
}

interface RawLink {
  doc_id: string;
  doc_ns: string;
  target_type: string;
  target_id: string;
  rel: string;
  source: string;
  created_by: string;
  created_at: string;
}

function toDoc(r: RawDoc): DocRow {
  return {
    id: r.id,
    ns: r.ns,
    slug: r.slug,
    handle: r.handle,
    title: r.title,
    scope: r.scope as DocScope,
    ownerIdentity: r.owner_identity,
    ownerHuman: r.owner_human,
    status: r.status as DocStatus,
    archivedFrom: r.archived_from as DocRow['archivedFrom'],
    restoredStatus: r.restored_status as DocStatus | null,
    restoredAt: r.restored_at,
    headId: r.head_id,
    reviewedRev: r.reviewed_rev,
    unreviewed: r.unreviewed === 1,
    conflicted: r.conflicted === 1,
    origin: r.origin,
    publishedPath: r.published_path,
    publishedRev: r.published_rev,
    publishedTask: r.published_task,
    publishedCommit: r.published_commit,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
    indexedHash: r.indexed_hash,
  };
}

function toMeta(r: RawRevision): RevisionMeta {
  return {
    id: r.id,
    docId: r.doc_id,
    n: r.n,
    parents: JSON.parse(r.parents_json) as string[],
    restoredParents:
      r.restored_parents_json === null
        ? null
        : (JSON.parse(r.restored_parents_json) as string[]),
    title: r.title,
    hash: r.hash,
    bytes: r.bytes,
    author: r.author,
    cause: r.cause as RevisionCause,
    summary: r.summary,
    approval:
      r.approval_json === null
        ? null
        : (JSON.parse(r.approval_json) as RevisionRow['approval']),
    conflicted: r.conflicted === 1,
    sealed: r.sealed === 1,
    unreviewed: r.unreviewed === 1,
    provisional: r.provisional === 1,
    via: r.via,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toLink(r: RawLink): LinkRow {
  return {
    docId: r.doc_id,
    docNs: r.doc_ns,
    targetType: r.target_type as LinkTargetType,
    targetId: r.target_id,
    rel: r.rel as LinkRel,
    source: r.source as LinkRow['source'],
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

interface RawProposal {
  rev_id: string;
  doc_id: string;
  base_rev: string;
  author: string;
  operator: string | null;
  run_id: string | null;
  task_id: string | null;
  origin: string;
  gate: string | null;
  state: string;
  decided_by: string | null;
  decided_by_policy_json: string | null;
  reason: string | null;
  result_rev: string | null;
  created_at: string;
  decided_at: string | null;
}

function toProposal(r: RawProposal): DocProposal {
  return {
    rev: r.rev_id,
    doc: r.doc_id,
    base: r.base_rev,
    author: r.author,
    operator: r.operator,
    runId: r.run_id,
    taskId: r.task_id,
    origin: r.origin,
    gate: r.gate,
    state: r.state as ProposalState,
    decidedBy: r.decided_by,
    decidedByPolicy:
      r.decided_by_policy_json === null
        ? null
        : (JSON.parse(
            r.decided_by_policy_json
          ) as DocProposal['decidedByPolicy']),
    reason: r.reason,
    result: r.result_rev,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

const bit = (value: boolean): number => (value ? 1 : 0);

// Each term with a letter or digit, double-quoted with inner quotes doubled, so
// FTS syntax in a query is only text.
function ftsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter((term) => /[\p{L}\p{N}]/u.test(term))
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' ');
}

const REVISION_COLUMNS =
  'id, doc_id, n, parents_json, restored_parents_json, title, hash, bytes, author, cause, summary, approval_json, conflicted, sealed, unreviewed, provisional, via, created_at, updated_at';

// docs.db's persistence seam: row reads and writes only, every rule lives in
// DocsService. Nested transaction() calls join the outermost one.
export class SqliteDocStore {
  private depth = 0;

  constructor(
    private readonly db: SqliteDatabase,
    readonly fts: boolean,
    private readonly path: string | null = null
  ) {}

  // One BEGIN IMMEDIATE per outermost call; nested calls join it.
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth += 1;
      try {
        return fn();
      } finally {
        this.depth -= 1;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth = 0;
    }
  }

  private one<T>(sql: string, params: SqlValue[] = []): T | undefined {
    return queryOne<T>(this.db, sql, params);
  }

  private all<T>(sql: string, params: SqlValue[] = []): T[] {
    return queryAll<T>(this.db, sql, params);
  }

  private run(sql: string, params: SqlValue[] = []): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  doc(id: string): DocRow | null {
    const row = this.one<RawDoc>('SELECT * FROM docs WHERE id = ?', [id]);
    return row === undefined ? null : toDoc(row);
  }

  docByHandle(ns: string, handle: string): DocRow | null {
    const row = this.one<RawDoc>(
      'SELECT * FROM docs WHERE ns = ? AND handle = ?',
      [ns, handle]
    );
    return row === undefined ? null : toDoc(row);
  }

  // The lowest-id doc a retired slug of `ns` names.
  docByAlias(ns: string, slug: string): DocRow | null {
    const row = this.one<RawDoc>(
      'SELECT d.* FROM slug_aliases a JOIN docs d ON d.id = a.doc_id WHERE a.ns = ? AND a.slug = ? ORDER BY d.id LIMIT 1',
      [ns, slug]
    );
    return row === undefined ? null : toDoc(row);
  }

  docByOrigin(origin: string): DocRow | null {
    const row = this.one<RawDoc>('SELECT * FROM docs WHERE origin = ?', [
      origin,
    ]);
    return row === undefined ? null : toDoc(row);
  }

  // A live handle or a retired slug; either one is never given to another doc
  // of `ns`. `except` names a doc whose own slugs do not count, for its rename.
  slugTaken(ns: string, slug: string, except = ''): boolean {
    const live = this.one<{ c: number }>(
      'SELECT COUNT(*) AS c FROM docs WHERE ns = ? AND (handle = ? OR slug = ?) AND id != ?',
      [ns, slug, slug, except]
    );
    const retired = this.one<{ c: number }>(
      'SELECT COUNT(*) AS c FROM slug_aliases WHERE ns = ? AND slug = ? AND doc_id != ?',
      [ns, slug, except]
    );
    return (live?.c ?? 0) + (retired?.c ?? 0) > 0;
  }

  listDocs(filter: DocListFilter): { rows: DocRow[]; total: number } {
    if (filter.ns.length === 0 || filter.statuses.length === 0) {
      return { rows: [], total: 0 };
    }
    const where: string[] = [
      `ns IN (${filter.ns.map(() => '?').join(', ')})`,
      `status IN (${filter.statuses.map(() => '?').join(', ')})`,
    ];
    const params: SqlValue[] = [...filter.ns, ...filter.statuses];
    if (filter.unreviewed === true) where.push('unreviewed = 1');
    // A doc with a sync problem needs a human as a conflicted one does.
    if (filter.conflicted === true)
      where.push(
        "(conflicted = 1 OR id IN (SELECT substr(key, 9) FROM meta WHERE key LIKE 'problem:%'))"
      );
    if (filter.ids !== undefined) {
      if (filter.ids.length === 0) return { rows: [], total: 0 };
      where.push(`id IN (${filter.ids.map(() => '?').join(', ')})`);
      params.push(...filter.ids);
    }
    if (filter.query !== undefined && filter.query.trim() !== '') {
      where.push("title LIKE ? ESCAPE '\\'");
      params.push(
        `%${filter.query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      );
    }
    const clause = where.join(' AND ');
    const total =
      this.one<{ c: number }>(
        `SELECT COUNT(*) AS c FROM docs WHERE ${clause}`,
        params
      )?.c ?? 0;
    const rows = this.all<RawDoc>(
      `SELECT * FROM docs WHERE ${clause} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`,
      [...params, filter.limit, filter.offset]
    ).map(toDoc);
    return { rows, total };
  }

  putDoc(r: DocRow): void {
    this.run(
      `INSERT INTO docs (id, ns, slug, handle, title, scope, owner_identity, owner_human, status,
        archived_from, restored_status, restored_at, head_id, reviewed_rev, unreviewed, conflicted,
        origin, published_path, published_rev, published_task, published_commit, created_by,
        created_at, updated_by, updated_at, indexed_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET ns = excluded.ns, slug = excluded.slug, handle = excluded.handle,
        title = excluded.title, scope = excluded.scope, owner_identity = excluded.owner_identity,
        owner_human = excluded.owner_human, status = excluded.status, archived_from = excluded.archived_from,
        restored_status = excluded.restored_status, restored_at = excluded.restored_at,
        head_id = excluded.head_id, reviewed_rev = excluded.reviewed_rev, unreviewed = excluded.unreviewed,
        conflicted = excluded.conflicted, origin = excluded.origin, published_path = excluded.published_path,
        published_rev = excluded.published_rev, published_task = excluded.published_task,
        published_commit = excluded.published_commit, updated_by = excluded.updated_by,
        updated_at = excluded.updated_at, indexed_hash = excluded.indexed_hash`,
      [
        r.id,
        r.ns,
        r.slug,
        r.handle,
        r.title,
        r.scope,
        r.ownerIdentity,
        r.ownerHuman,
        r.status,
        r.archivedFrom,
        r.restoredStatus,
        r.restoredAt,
        r.headId,
        r.reviewedRev,
        bit(r.unreviewed),
        bit(r.conflicted),
        r.origin,
        r.publishedPath,
        r.publishedRev,
        r.publishedTask,
        r.publishedCommit,
        r.createdBy,
        r.createdAt,
        r.updatedBy,
        r.updatedAt,
        r.indexedHash,
      ]
    );
  }

  // Removes every row of a doc, and every link pointing at it; the caller writes the tombstone.
  deleteDoc(docId: string): void {
    this.transaction(() => {
      for (const table of [
        'revisions',
        'reviews',
        'proposals',
        'sections',
        'links',
        'slug_aliases',
        'assets',
        'publishes',
      ]) {
        this.run(`DELETE FROM ${table} WHERE doc_id = ?`, [docId]);
      }
      if (this.fts) {
        this.run('DELETE FROM sections_fts WHERE doc_id = ?', [docId]);
      }
      this.run(
        "DELETE FROM links WHERE target_type = 'doc' AND target_id = ?",
        [docId]
      );
      this.run('DELETE FROM docs WHERE id = ?', [docId]);
    });
  }

  revision(id: string): RevisionRow | null {
    const row = this.one<RawRevision>(
      `SELECT ${REVISION_COLUMNS}, body FROM revisions WHERE id = ?`,
      [id]
    );
    return row === undefined ? null : { ...toMeta(row), body: row.body ?? '' };
  }

  // A revision without its body, for flags and history.
  revisionMeta(id: string): RevisionMeta | null {
    const row = this.one<RawRevision>(
      `SELECT ${REVISION_COLUMNS} FROM revisions WHERE id = ?`,
      [id]
    );
    return row === undefined ? null : toMeta(row);
  }

  revisionByN(docId: string, n: number): RevisionRow | null {
    const row = this.one<{ id: string }>(
      'SELECT id FROM revisions WHERE doc_id = ? AND n = ?',
      [docId, n]
    );
    return row === undefined ? null : this.revision(row.id);
  }

  // History, newest first: numbered revisions only, so proposals never appear.
  revisionMetas(
    docId: string,
    page: { before?: number; limit: number }
  ): RevisionMeta[] {
    const before = page.before ?? Number.MAX_SAFE_INTEGER;
    return this.all<RawRevision>(
      `SELECT ${REVISION_COLUMNS} FROM revisions WHERE doc_id = ? AND n IS NOT NULL AND n < ? ORDER BY n DESC LIMIT ?`,
      [docId, before, page.limit]
    ).map(toMeta);
  }

  maxN(docId: string): number {
    return (
      this.one<{ m: number | null }>(
        'SELECT MAX(n) AS m FROM revisions WHERE doc_id = ?',
        [docId]
      )?.m ?? 0
    );
  }

  insertRevision(r: RevisionRow): void {
    this.run(
      `INSERT INTO revisions (id, doc_id, n, parents_json, restored_parents_json, title, body, hash, bytes,
        author, cause, summary, approval_json, conflicted, sealed, unreviewed, provisional, via,
        created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.id,
        r.docId,
        r.n,
        JSON.stringify(r.parents),
        r.restoredParents === null ? null : JSON.stringify(r.restoredParents),
        r.title,
        r.body,
        r.hash,
        r.bytes,
        r.author,
        r.cause,
        r.summary,
        r.approval === null ? null : JSON.stringify(r.approval),
        bit(r.conflicted),
        bit(r.sealed),
        bit(r.unreviewed),
        bit(r.provisional),
        r.via,
        r.createdAt,
        r.updatedAt,
      ]
    );
  }

  // Rewrites an open revision in place; a sealed one is left untouched.
  amendRevision(
    id: string,
    p: Pick<
      RevisionRow,
      'title' | 'body' | 'hash' | 'bytes' | 'summary' | 'updatedAt'
    >
  ): void {
    this.run(
      'UPDATE revisions SET title = ?, body = ?, hash = ?, bytes = ?, summary = ?, updated_at = ? WHERE id = ? AND sealed = 0',
      [p.title, p.body, p.hash, p.bytes, p.summary, p.updatedAt, id]
    );
  }

  sealRevision(id: string): void {
    this.run('UPDATE revisions SET sealed = 1 WHERE id = ?', [id]);
  }

  setRevisionN(id: string, n: number): void {
    this.run('UPDATE revisions SET n = ? WHERE id = ?', [n, id]);
  }

  hasReview(revId: string): boolean {
    return (
      (this.one<{ c: number }>(
        'SELECT COUNT(*) AS c FROM reviews WHERE rev_id = ?',
        [revId]
      )?.c ?? 0) > 0
    );
  }

  addReview(docId: string, revId: string, by: string, at: string): void {
    this.run(
      'INSERT OR IGNORE INTO reviews (doc_id, rev_id, by, at) VALUES (?, ?, ?, ?)',
      [docId, revId, by, at]
    );
  }

  // Rebuilds a doc's section index (and FTS rows) from its head, recording the hash it came from.
  replaceSections(
    docId: string,
    title: string,
    rows: readonly SectionRow[],
    indexedHash: string
  ): void {
    this.transaction(() => {
      this.run('DELETE FROM sections WHERE doc_id = ?', [docId]);
      if (this.fts) {
        this.run('DELETE FROM sections_fts WHERE doc_id = ?', [docId]);
      }
      for (const s of rows) {
        this.run(
          'INSERT INTO sections (doc_id, ord, level, heading, anchor, start_byte, end_byte) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [docId, s.ord, s.level, s.heading, s.anchor, s.startByte, s.endByte]
        );
        if (this.fts) {
          this.run(
            'INSERT INTO sections_fts (doc_id, ord, title, heading, text) VALUES (?, ?, ?, ?, ?)',
            [docId, s.ord, title, s.heading, s.text]
          );
        }
      }
      this.run('UPDATE docs SET indexed_hash = ? WHERE id = ?', [
        indexedHash,
        docId,
      ]);
    });
  }

  sectionRows(docId: string): Omit<SectionRow, 'text'>[] {
    return this.all<{
      ord: number;
      level: number;
      heading: string;
      anchor: string;
      start_byte: number;
      end_byte: number;
    }>(
      'SELECT ord, level, heading, anchor, start_byte, end_byte FROM sections WHERE doc_id = ? ORDER BY ord',
      [docId]
    ).map((r) => ({
      ord: r.ord,
      level: r.level,
      heading: r.heading,
      anchor: r.anchor,
      startByte: r.start_byte,
      endByte: r.end_byte,
    }));
  }

  links(filter: {
    docId?: string;
    target?: { type: LinkTargetType; id: string };
  }): LinkRow[] {
    if (filter.docId !== undefined) {
      return this.all<RawLink>(
        'SELECT * FROM links WHERE doc_id = ? ORDER BY created_at, target_type, target_id',
        [filter.docId]
      ).map(toLink);
    }
    if (filter.target !== undefined) {
      return this.all<RawLink>(
        'SELECT * FROM links WHERE target_type = ? AND target_id = ? ORDER BY created_at, doc_id',
        [filter.target.type, filter.target.id]
      ).map(toLink);
    }
    return [];
  }

  addLink(l: LinkRow): void {
    this.run(
      `INSERT INTO links (doc_id, doc_ns, target_type, target_id, rel, source, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (doc_id, target_type, target_id) DO UPDATE SET rel = excluded.rel, source = excluded.source,
        created_by = excluded.created_by, created_at = excluded.created_at`,
      [
        l.docId,
        l.docNs,
        l.targetType,
        l.targetId,
        l.rel,
        l.source,
        l.createdBy,
        l.createdAt,
      ]
    );
  }

  removeLink(docId: string, type: LinkTargetType, id: string): boolean {
    return (
      this.run(
        'DELETE FROM links WHERE doc_id = ? AND target_type = ? AND target_id = ?',
        [docId, type, id]
      ) > 0
    );
  }

  // Swaps a doc's derived mention links; a manual link to the same target wins.
  replaceMentions(
    docId: string,
    docNs: string,
    rows: readonly LinkRow[]
  ): void {
    this.transaction(() => {
      this.run("DELETE FROM links WHERE doc_id = ? AND source = 'mention'", [
        docId,
      ]);
      for (const l of rows) {
        this.run(
          `INSERT OR IGNORE INTO links (doc_id, doc_ns, target_type, target_id, rel, source, created_by, created_at)
           VALUES (?, ?, ?, ?, 'context', 'mention', ?, ?)`,
          [docId, docNs, l.targetType, l.targetId, l.createdBy, l.createdAt]
        );
      }
    });
  }

  specFor(type: LinkTargetType, id: string, docNs: string): LinkRow | null {
    const row = this.one<RawLink>(
      "SELECT * FROM links WHERE target_type = ? AND target_id = ? AND doc_ns = ? AND rel = 'spec'",
      [type, id, docNs]
    );
    return row === undefined ? null : toLink(row);
  }

  addAlias(ns: string, slug: string, docId: string, at: string): void {
    this.run(
      'INSERT OR IGNORE INTO slug_aliases (ns, slug, doc_id, retired_at) VALUES (?, ?, ?, ?)',
      [ns, slug, docId, at]
    );
  }

  putTombstone(t: {
    docId: string;
    ns: string;
    slug: string;
    origin: string | null;
    deletedBy: string;
    at: string;
  }): void {
    this.run(
      'INSERT OR REPLACE INTO tombstones (doc_id, ns, slug, origin, deleted_by, at) VALUES (?, ?, ?, ?, ?, ?)',
      [t.docId, t.ns, t.slug, t.origin, t.deletedBy, t.at]
    );
  }

  tombstone(
    docId: string
  ): { docId: string; ns: string; origin: string | null } | null {
    const row = this.one<{ doc_id: string; ns: string; origin: string | null }>(
      'SELECT doc_id, ns, origin FROM tombstones WHERE doc_id = ?',
      [docId]
    );
    return row === undefined
      ? null
      : { docId: row.doc_id, ns: row.ns, origin: row.origin };
  }

  tombstonedOrigin(origin: string): boolean {
    return (
      (this.one<{ c: number }>(
        'SELECT COUNT(*) AS c FROM tombstones WHERE origin = ?',
        [origin]
      )?.c ?? 0) > 0
    );
  }

  countCreatedSince(by: string, sinceIso: string): number {
    return (
      this.one<{ c: number }>(
        'SELECT COUNT(*) AS c FROM docs WHERE created_by = ? AND created_at > ?',
        [by, sinceIso]
      )?.c ?? 0
    );
  }

  putProposal(p: DocProposal): void {
    this.run(
      `INSERT OR REPLACE INTO proposals (rev_id, doc_id, base_rev, author, operator, run_id, task_id, origin, gate, state,
        decided_by, decided_by_policy_json, reason, result_rev, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        p.rev,
        p.doc,
        p.base,
        p.author,
        p.operator,
        p.runId,
        p.taskId,
        p.origin,
        p.gate,
        p.state,
        p.decidedBy,
        p.decidedByPolicy === null ? null : JSON.stringify(p.decidedByPolicy),
        p.reason,
        p.result,
        p.createdAt,
        p.decidedAt,
      ]
    );
  }

  // INSERT OR IGNORE: a name is the hash of its bytes, so a second upload is the same asset.
  putAsset(a: AssetRow): void {
    this.run(
      'INSERT OR IGNORE INTO assets (doc_id, name, bytes, mime, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [a.doc, a.name, a.bytes, a.mime, a.createdBy, a.createdAt]
    );
  }

  assetRow(docId: string, name: string): AssetRow | null {
    const r = this.one<{
      doc_id: string;
      name: string;
      bytes: number;
      mime: string;
      created_by: string;
      created_at: string;
    }>('SELECT * FROM assets WHERE doc_id = ? AND name = ?', [docId, name]);
    return r === undefined
      ? null
      : {
          doc: r.doc_id,
          name: r.name,
          bytes: r.bytes,
          mime: r.mime,
          createdBy: r.created_by,
          createdAt: r.created_at,
        };
  }

  // How many images a doc stores, and their total bytes.
  assetUsage(docId: string): { files: number; bytes: number } {
    const r = this.one<{ files: number; bytes: number | null }>(
      'SELECT COUNT(*) AS files, SUM(bytes) AS bytes FROM assets WHERE doc_id = ?',
      [docId]
    );
    return { files: r?.files ?? 0, bytes: r?.bytes ?? 0 };
  }

  // Every image's bytes in the project.
  assetBytesTotal(): number {
    return (
      this.one<{ bytes: number | null }>(
        'SELECT SUM(bytes) AS bytes FROM assets'
      )?.bytes ?? 0
    );
  }

  // Asset rows created before `beforeIso` and not found referenced since then, oldest first.
  assetsToCheck(beforeIso: string): AssetRow[] {
    return this.all<{
      doc_id: string;
      name: string;
      bytes: number;
      mime: string;
      created_by: string;
      created_at: string;
    }>(
      'SELECT * FROM assets WHERE created_at < ? AND (checked_at IS NULL OR checked_at < ?) ORDER BY created_at, doc_id, name',
      [beforeIso, beforeIso]
    ).map((r) => ({
      doc: r.doc_id,
      name: r.name,
      bytes: r.bytes,
      mime: r.mime,
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
  }

  // Whether any revision of the doc, a proposal's included, links `asset:<name>`.
  assetReferenced(docId: string, name: string): boolean {
    return (
      this.one<{ hit: number }>(
        'SELECT 1 AS hit FROM revisions WHERE doc_id = ? AND instr(body, ?) > 0 LIMIT 1',
        [docId, `asset:${name}`]
      ) !== undefined
    );
  }

  // An image found referenced at `atIso`; the sweep skips it until that is old.
  // The newest image stamp, so a sweep can tell a clock that ran fast.
  newestAssetAt(): string | null {
    return (
      this.all<{ at: string | null }>(
        'SELECT MAX(created_at) AS at FROM assets',
        []
      )[0]?.at ?? null
    );
  }

  markAssetChecked(docId: string, name: string, atIso: string): void {
    this.run('UPDATE assets SET checked_at = ? WHERE doc_id = ? AND name = ?', [
      atIso,
      docId,
      name,
    ]);
  }

  deleteAsset(docId: string, name: string): void {
    this.run('DELETE FROM assets WHERE doc_id = ? AND name = ?', [docId, name]);
  }

  putPublish(p: PublishRow): void {
    this.run(
      'INSERT OR REPLACE INTO publishes (task_id, doc_id, rev_id, path, state, "commit", created_at, reason, idem_key, dispatch_actor, dispatch_operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        p.task,
        p.doc,
        p.rev,
        p.path,
        p.state,
        p.commit,
        p.createdAt,
        p.reason,
        p.idemKey ?? null,
        p.dispatchAs?.actor ?? null,
        p.dispatchAs?.operator ?? null,
      ]
    );
  }

  deletePublish(task: string): void {
    this.run('DELETE FROM publishes WHERE task_id = ?', [task]);
  }

  // Publish rows matching every given filter, newest first.
  publishRows(filter: {
    doc?: string;
    task?: string;
    state?: PublishRow['state'];
    idemKey?: string;
  }): PublishRow[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    for (const [column, value] of [
      ['doc_id', filter.doc],
      ['task_id', filter.task],
      ['state', filter.state],
      ['idem_key', filter.idemKey],
    ] as const) {
      if (value === undefined) continue;
      where.push(`${column} = ?`);
      params.push(value);
    }
    const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
    return this.all<{
      task_id: string;
      doc_id: string;
      rev_id: string;
      path: string;
      state: PublishRow['state'];
      commit: string | null;
      created_at: string;
      reason: string | null;
      idem_key: string | null;
      dispatch_actor: string | null;
      dispatch_operator: string | null;
    }>(
      `SELECT * FROM publishes${clause} ORDER BY created_at DESC, task_id DESC`,
      params
    ).map((r) => ({
      task: r.task_id,
      doc: r.doc_id,
      rev: r.rev_id,
      path: r.path,
      state: r.state,
      commit: r.commit,
      createdAt: r.created_at,
      reason: r.reason,
      idemKey: r.idem_key,
      dispatchAs:
        r.dispatch_actor === null
          ? null
          : { actor: r.dispatch_actor, operator: r.dispatch_operator },
    }));
  }

  // Proposal rows matching every given filter, oldest first.
  proposalRows(filter: {
    rev?: string;
    doc?: string;
    states?: readonly ProposalState[];
    author?: string;
  }): DocProposal[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.rev !== undefined) {
      where.push('rev_id = ?');
      params.push(filter.rev);
    }
    if (filter.doc !== undefined) {
      where.push('doc_id = ?');
      params.push(filter.doc);
    }
    if (filter.author !== undefined) {
      where.push('author = ?');
      params.push(filter.author);
    }
    if (filter.states !== undefined) {
      where.push(`state IN (${filter.states.map(() => '?').join(', ')})`);
      params.push(...filter.states);
    }
    const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
    return this.all<RawProposal>(
      `SELECT * FROM proposals${clause} ORDER BY created_at, rev_id`,
      params
    ).map(toProposal);
  }

  // Local proposals an author made since `sinceIso`, for the hourly limit.
  countProposalsSince(author: string, sinceIso: string): number {
    return (
      this.one<{ c: number }>(
        "SELECT COUNT(*) AS c FROM proposals WHERE author = ? AND created_at > ? AND origin = 'local'",
        [author, sinceIso]
      )?.c ?? 0
    );
  }

  // Unsealed revisions that are some doc's head, for the sweep that seals them.
  openHeads(): RevisionMeta[] {
    return this.all<RawRevision>(
      `SELECT ${REVISION_COLUMNS.split(', ')
        .map((c) => `r.${c}`)
        .join(
          ', '
        )} FROM revisions r JOIN docs d ON d.head_id = r.id WHERE r.sealed = 0`
    ).map(toMeta);
  }

  // Docs whose section index was built from a body other than the head's.
  staleIndexes(): { docId: string; headId: string }[] {
    return this.all<{ id: string; head_id: string }>(
      'SELECT d.id, d.head_id FROM docs d JOIN revisions r ON r.id = d.head_id WHERE d.indexed_hash IS NULL OR d.indexed_hash != r.hash ORDER BY d.id'
    ).map((r) => ({ docId: r.id, headId: r.head_id }));
  }

  // Ranks head sections with bm25, title weighted over heading over text; ties
  // break on doc id and section order so results are stable. `ids` narrows to those docs.
  search(
    query: string,
    ns: readonly string[],
    opts: { includeArchived: boolean; limit: number; ids?: readonly string[] }
  ): SearchRow[] {
    if (!this.fts) {
      throw new Error('FTS5 is not available; use the LIKE fallback');
    }
    const match = ftsQuery(query);
    const ids = opts.ids;
    if (match === '' || ns.length === 0 || ids?.length === 0) return [];
    const only =
      ids === undefined
        ? ''
        : ` AND d.id IN (${ids.map(() => '?').join(', ')})`;
    return this.all<SearchRow>(
      `SELECT sections_fts.doc_id AS docId, sections_fts.ord AS ord, s.heading AS heading, s.anchor AS anchor,
        snippet(sections_fts, 4, '[', ']', '…', 24) AS snippet,
        bm25(sections_fts, 0.0, 0.0, 5.0, 3.0, 1.0) AS score
       FROM sections_fts
       JOIN docs d ON d.id = sections_fts.doc_id
       JOIN sections s ON s.doc_id = sections_fts.doc_id AND s.ord = sections_fts.ord
       WHERE sections_fts MATCH ? AND d.ns IN (${ns.map(() => '?').join(', ')})
         AND (? = 1 OR d.status != 'archived')${only}
       ORDER BY score, sections_fts.doc_id, sections_fts.ord LIMIT ?`,
      [match, ...ns, bit(opts.includeArchived), ...(ids ?? []), opts.limit]
    );
  }

  // Every head body in `ns`, newest first, for the LIKE fallback's scan.
  headBodies(
    ns: readonly string[],
    includeArchived: boolean
  ): { doc: DocRow; body: string }[] {
    if (ns.length === 0) return [];
    return this.all<RawDoc & { head_body: string }>(
      `SELECT d.*, r.body AS head_body FROM docs d JOIN revisions r ON r.id = d.head_id
       WHERE d.ns IN (${ns.map(() => '?').join(', ')}) AND (? = 1 OR d.status != 'archived') ORDER BY d.updated_at DESC`,
      [...ns, bit(includeArchived)]
    ).map((r) => ({ doc: toDoc(r), body: r.head_body }));
  }

  // Import sessions: a manifest and its uploaded contents, plus what earlier imports brought in.

  putImportSession(s: {
    id: string;
    createdBy: string;
    createdAt: string;
    touchedAt: string;
    manifest: string;
    link: string | null;
  }): void {
    this.run(
      'INSERT OR REPLACE INTO import_sessions (id, created_by, created_at, touched_at, manifest_json, link) VALUES (?, ?, ?, ?, ?, ?)',
      [s.id, s.createdBy, s.createdAt, s.touchedAt, s.manifest, s.link]
    );
  }

  // An open import: who opened it, when it was last used, its manifest as JSON
  // and the `type:id` every imported doc links as context.
  importSession(id: string): {
    id: string;
    createdBy: string;
    touchedAt: string;
    manifest: string;
    link: string | null;
  } | null {
    const r = this.one<{
      id: string;
      created_by: string;
      touched_at: string;
      manifest_json: string;
      link: string | null;
    }>(
      'SELECT id, created_by, touched_at, manifest_json, link FROM import_sessions WHERE id = ?',
      [id]
    );
    return r === undefined
      ? null
      : {
          id: r.id,
          createdBy: r.created_by,
          touchedAt: r.touched_at,
          manifest: r.manifest_json,
          link: r.link,
        };
  }

  importSessionsBy(by: string): string[] {
    return this.all<{ id: string }>(
      'SELECT id FROM import_sessions WHERE created_by = ?',
      [by]
    ).map((r) => r.id);
  }

  idleImportSessions(beforeIso: string): string[] {
    return this.all<{ id: string }>(
      'SELECT id FROM import_sessions WHERE touched_at < ?',
      [beforeIso]
    ).map((r) => r.id);
  }

  deleteImportSession(id: string): void {
    this.transaction(() => {
      this.run('DELETE FROM import_contents WHERE import_id = ?', [id]);
      this.run('DELETE FROM import_sessions WHERE id = ?', [id]);
    });
  }

  touchImportSession(id: string, at: string): void {
    this.run('UPDATE import_sessions SET touched_at = ? WHERE id = ?', [
      at,
      id,
    ]);
  }

  putImportContent(id: string, hash: string, bytes: Uint8Array): void {
    this.run(
      'INSERT OR REPLACE INTO import_contents (import_id, hash, body) VALUES (?, ?, ?)',
      [id, hash, bytes]
    );
  }

  importContent(id: string, hash: string): Uint8Array | null {
    return (
      this.one<{ body: Uint8Array }>(
        'SELECT body FROM import_contents WHERE import_id = ? AND hash = ?',
        [id, hash]
      )?.body ?? null
    );
  }

  // Bytes already uploaded to a session, other than `except`'s, for its 64 MiB bound.
  importContentBytes(id: string, except = ''): number {
    return (
      this.one<{ b: number | null }>(
        'SELECT SUM(LENGTH(body)) AS b FROM import_contents WHERE import_id = ? AND hash != ?',
        [id, except]
      )?.b ?? 0
    );
  }

  isImported(ns: string, slug: string, hash: string): boolean {
    return (
      (this.one<{ c: number }>(
        'SELECT COUNT(*) AS c FROM imported WHERE ns = ? AND slug = ? AND hash = ?',
        [ns, slug, hash]
      )?.c ?? 0) > 0
    );
  }

  markImported(
    ns: string,
    slug: string,
    hash: string,
    docId: string,
    at: string
  ): void {
    this.run(
      'INSERT OR IGNORE INTO imported (ns, slug, hash, doc_id, at) VALUES (?, ?, ?, ?, ?)',
      [ns, slug, hash, docId, at]
    );
  }

  meta(key: string): string | null {
    return (
      this.one<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])
        ?.value ?? null
    );
  }

  deleteMeta(key: string): void {
    this.run('DELETE FROM meta WHERE key = ?', [key]);
  }

  // The Linear document a doc syncs with: its id, the last synced revision
  // and the Linear `updatedAt` that revision matched.
  linearDoc(docId: string): LinearDocRow | null {
    const r = this.one<RawLinearDoc>(
      'SELECT * FROM linear_docs WHERE doc_id = ?',
      [docId]
    );
    return r === undefined ? null : toLinearDoc(r);
  }

  linearDocByDocument(documentId: string): LinearDocRow | null {
    const r = this.one<RawLinearDoc>(
      'SELECT * FROM linear_docs WHERE document_id = ?',
      [documentId]
    );
    return r === undefined ? null : toLinearDoc(r);
  }

  // Linear-synced docs whose head moved past the last synced revision.
  linearChanged(): string[] {
    return this.all<{ doc_id: string }>(
      'SELECT l.doc_id FROM linear_docs l JOIN docs d ON d.id = l.doc_id WHERE d.head_id != l.base_rev ORDER BY l.doc_id'
    ).map((r) => r.doc_id);
  }

  putLinearDoc(row: LinearDocRow): void {
    this.run(
      'INSERT OR REPLACE INTO linear_docs (doc_id, document_id, base_rev, remote_updated_at) VALUES (?, ?, ?, ?)',
      [row.docId, row.documentId, row.baseRev, row.remoteUpdatedAt]
    );
  }

  setMeta(key: string, value: string): void {
    this.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
      key,
      value,
    ]);
  }

  // The database file's size, for health; 0 for an in-memory store.
  fileBytes(): number {
    if (this.path === null) return 0;
    try {
      return statSync(this.path).size;
    } catch {
      return 0;
    }
  }

  close(): void {
    this.db.close();
  }
}
