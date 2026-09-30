import { queryAll, queryOne } from '@dispatch/core';
import type { SqliteDatabase, SqlValue } from '@dispatch/core';
import type { Address } from '@dispatch/protocol';
import { SYSTEM_ADDRESS } from '@dispatch/protocol';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
} from 'node:fs';

import type { ManifestRow } from './claudeFiles.js';
import { memoryContentHash } from './contentHash.js';
import { MemoryError } from './errors.js';
import { cutUtf8 } from './limits.js';
import type { SearchMode } from './schema.js';
import type {
  ActivityRow,
  EntryFilter,
  IngestProblem,
  IngestProblemRow,
  MemoryStore,
  RecallRow,
  SearchHit,
} from './store.js';
import type {
  DisplayState,
  MemoryEntry,
  MemoryProposal,
  MemoryScope,
  ProposalState,
  RecallVia,
  Revision,
  RevisionCause,
} from './types.js';

const COLUMNS = [
  'id',
  'handle',
  'scope',
  'kind',
  'title',
  'body',
  'refs',
  'epic',
  'applies_to',
  'project_key',
  'author',
  'trust',
  'status',
  'status_reason',
  'decay',
  'pinned',
  'supersedes',
  'superseded_by',
  'origin',
  'proposal_id',
  'decided_by',
  'decided_by_policy',
  'rev',
  'content_hash',
  'created_at',
  'updated_at',
  'last_recalled_at',
  'recall_count',
] as const;

interface EntryRow {
  id: string;
  handle: string;
  scope: string;
  kind: string;
  title: string;
  body: string;
  refs: string;
  epic: string | null;
  applies_to: string;
  project_key: string | null;
  author: string;
  trust: string;
  status: string;
  status_reason: string | null;
  decay: string;
  pinned: number;
  supersedes: string | null;
  superseded_by: string | null;
  origin: string | null;
  proposal_id: string | null;
  decided_by: string | null;
  decided_by_policy: string | null;
  rev: number;
  content_hash: string;
  created_at: string;
  updated_at: string;
  last_recalled_at: string | null;
  recall_count: number;
}

// The values of COLUMNS, in order; refs, appliesTo and the policy decision as JSON text.
function entryParams(e: MemoryEntry): SqlValue[] {
  return [
    e.id,
    e.handle,
    e.scope,
    e.kind,
    e.title,
    e.body,
    JSON.stringify(e.refs),
    e.epic,
    JSON.stringify(e.appliesTo),
    e.projectKey,
    e.author,
    e.trust,
    e.status,
    e.statusReason,
    e.decay,
    e.pinned ? 1 : 0,
    e.supersedes,
    e.supersededBy,
    e.origin,
    e.proposal,
    e.decidedBy,
    e.decidedByPolicy === null ? null : JSON.stringify(e.decidedByPolicy),
    e.rev,
    memoryContentHash(e),
    e.createdAt,
    e.updatedAt,
    e.lastRecalledAt,
    e.recallCount,
  ];
}

function entryFromRow(r: EntryRow): MemoryEntry {
  return {
    id: r.id,
    handle: r.handle,
    scope: r.scope as MemoryEntry['scope'],
    kind: r.kind as MemoryEntry['kind'],
    title: r.title,
    body: r.body,
    refs: JSON.parse(r.refs) as MemoryEntry['refs'],
    epic: r.epic,
    appliesTo: JSON.parse(r.applies_to) as string[],
    projectKey: r.project_key,
    author: r.author,
    trust: r.trust as MemoryEntry['trust'],
    status: r.status as MemoryEntry['status'],
    statusReason: r.status_reason as MemoryEntry['statusReason'],
    decay: r.decay as MemoryEntry['decay'],
    pinned: r.pinned === 1,
    supersedes: r.supersedes,
    supersededBy: r.superseded_by,
    origin: r.origin,
    proposal: r.proposal_id,
    decidedBy: r.decided_by,
    decidedByPolicy:
      r.decided_by_policy === null
        ? null
        : (JSON.parse(r.decided_by_policy) as MemoryEntry['decidedByPolicy']),
    rev: r.rev,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastRecalledAt: r.last_recalled_at,
    recallCount: r.recall_count,
  };
}

// Displayed state as SQL: expired entries read as retired, like displayState().
const STATE_SQL: Record<DisplayState, string> = {
  active: "(e.status = 'active' AND e.decay = 'fresh')",
  stale: "(e.status = 'active' AND e.decay = 'stale')",
  retired: "(e.status = 'retired' OR e.decay = 'expired')",
};

// The WHERE clause (without WHERE) and its parameters for an EntryFilter.
function filterSql(filter: EntryFilter): { where: string; params: SqlValue[] } {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  const inList = (column: string, values: readonly string[]) => {
    clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`);
    params.push(...values);
  };
  if (filter.scopes !== undefined) inList('e.scope', filter.scopes);
  if (filter.kinds !== undefined) inList('e.kind', filter.kinds);
  if (filter.ids !== undefined) inList('e.id', filter.ids);
  // An empty state list matches nothing, rather than every row.
  if (filter.states !== undefined)
    clauses.push(
      filter.states.length === 0
        ? '0'
        : `(${filter.states.map((s) => STATE_SQL[s]).join(' OR ')})`
    );
  if (filter.projectKey !== undefined) {
    clauses.push('(e.project_key IS NULL OR e.project_key = ?)');
    params.push(filter.projectKey);
  }
  return { where: clauses.join(' AND '), params };
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// SQLite-backed MemoryStore; searches with FTS5 when the open found it, else LIKE.
export class SqliteMemoryStore implements MemoryStore {
  readonly search: SearchMode;
  private readonly db: SqliteDatabase;
  private depth = 0;

  constructor(opened: { db: SqliteDatabase; search: SearchMode }) {
    this.db = opened.db;
    this.search = opened.search;
  }

  // BEGIN IMMEDIATE takes the write lock up front, so two daemons sharing a
  // personal file queue behind busy_timeout instead of failing mid-write.
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
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

  getEntry(id: string): MemoryEntry | null {
    const row = queryOne<EntryRow>(
      this.db,
      'SELECT * FROM entries e WHERE e.id = ?',
      [id]
    );
    return row === undefined ? null : entryFromRow(row);
  }

  entriesByHandle(handle: string): MemoryEntry[] {
    return queryAll<EntryRow>(
      this.db,
      'SELECT * FROM entries e WHERE e.handle = ?',
      [handle]
    ).map(entryFromRow);
  }

  entryByOrigin(origin: string): MemoryEntry | null {
    const row = queryOne<EntryRow>(
      this.db,
      'SELECT * FROM entries e WHERE e.origin = ?',
      [origin]
    );
    return row === undefined ? null : entryFromRow(row);
  }

  listEntries(filter: EntryFilter = {}): MemoryEntry[] {
    const { where, params } = filterSql(filter);
    return queryAll<EntryRow>(
      this.db,
      `SELECT * FROM entries e${where === '' ? '' : ` WHERE ${where}`} ORDER BY e.seq`,
      params
    ).map(entryFromRow);
  }

  // Terms are quoted, so FTS operator words and syntax match as plain text.
  searchEntries(
    terms: readonly string[],
    match: 'all' | 'any',
    filter: EntryFilter,
    limit: number
  ): SearchHit[] {
    if (terms.length === 0) return [];
    const { where, params } = filterSql(filter);
    const and = where === '' ? '' : ` AND ${where}`;
    if (this.search === 'fts5') {
      const query = terms
        .map((t) => `"${t.replace(/"/g, '""')}"`)
        .join(match === 'all' ? ' ' : ' OR ');
      const rows = queryAll<EntryRow & { score: number; snip: string }>(
        this.db,
        `SELECT e.*, bm25(entries_fts) AS score, snippet(entries_fts, 1, '', '', '…', 16) AS snip
         FROM entries_fts JOIN entries e ON e.seq = entries_fts.rowid
         WHERE entries_fts MATCH ?${and} ORDER BY score, e.id LIMIT ?`,
        [query, ...params, limit]
      );
      return rows.map((r) => ({
        entry: entryFromRow(r),
        score: r.score,
        snippet: r.snip,
      }));
    }
    const likes = terms.map(
      () =>
        "(lower(e.title) LIKE ? ESCAPE '\\' OR lower(e.body) LIKE ? ESCAPE '\\')"
    );
    const likeParams = terms.flatMap((t) => {
      const pattern = `%${escapeLike(t.toLowerCase())}%`;
      return [pattern, pattern];
    });
    const rows = queryAll<EntryRow>(
      this.db,
      `SELECT * FROM entries e WHERE (${likes.join(match === 'all' ? ' AND ' : ' OR ')})${and}
       ORDER BY e.updated_at DESC, e.id LIMIT ?`,
      [...likeParams, ...params, limit]
    );
    return rows.map((r) => ({
      entry: entryFromRow(r),
      score: 0,
      snippet: cutUtf8(r.body, 160),
    }));
  }

  insertEntry(entry: MemoryEntry, by: Address, cause: RevisionCause): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO entries (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`
        )
        .run(...entryParams(entry));
      this.appendRevision(entry, by, cause);
    });
  }

  updateEntry(entry: MemoryEntry, by: Address, cause: RevisionCause): void {
    this.transaction(() => {
      const current = this.getEntry(entry.id);
      if (current === null)
        throw new MemoryError('not-found', `no memory ${entry.id}`, 'id');
      if (entry.rev !== current.rev + 1)
        throw new MemoryError(
          'conflict',
          `${current.handle} changed meanwhile (now rev ${current.rev})`,
          'id'
        );
      const sets = COLUMNS.filter((c) => c !== 'id')
        .map((c) => `${c} = ?`)
        .join(', ');
      this.db
        .prepare(`UPDATE entries SET ${sets} WHERE id = ?`)
        .run(...entryParams(entry).slice(1), entry.id);
      this.appendRevision(entry, by, cause);
    });
  }

  // Removes the entry and every row that holds its content; an imported
  // entry leaves a tombstone so a re-import never brings it back.
  deleteEntry(id: string, by: Address, at: string): void {
    this.transaction(() => {
      const entry = this.getEntry(id);
      if (entry === null)
        throw new MemoryError('not-found', `no memory ${id}`, 'id');
      if (entry.origin !== null) {
        this.db
          .prepare(
            'INSERT OR REPLACE INTO deleted_origins (origin, entry_id, deleted_by, at) VALUES (?, ?, ?, ?)'
          )
          .run(entry.origin, id, by, at);
      }
      for (const table of ['revisions', 'recalls', 'activity', 'exports'])
        this.db.prepare(`DELETE FROM ${table} WHERE memory_id = ?`).run(id);
      this.db.prepare('DELETE FROM entries WHERE id = ?').run(id);
    });
  }

  revisions(id: string): Revision[] {
    return queryAll<{
      memory_id: string;
      rev: number;
      snapshot_json: string;
      by_addr: string;
      cause: string;
      at: string;
    }>(this.db, 'SELECT * FROM revisions WHERE memory_id = ? ORDER BY rev', [
      id,
    ]).map((r) => ({
      memoryId: r.memory_id,
      rev: r.rev,
      snapshot: JSON.parse(r.snapshot_json) as MemoryEntry,
      by: r.by_addr,
      cause: r.cause as RevisionCause,
      at: r.at,
    }));
  }

  // Every recall bumps the count; only one that counts as use moves the decay
  // clock and revives a stale or expired entry.
  recordRecall(
    memoryId: string,
    input: {
      runId: string | null;
      via: RecallVia;
      at: string;
      countsAsUse: boolean;
    }
  ): void {
    this.transaction(() => {
      if (input.runId !== null) {
        this.db
          .prepare(
            'INSERT OR IGNORE INTO recalls (memory_id, run_id, via, at) VALUES (?, ?, ?, ?)'
          )
          .run(memoryId, input.runId, input.via, input.at);
      }
      const entry = this.getEntry(memoryId);
      if (entry === null) return;
      if (!input.countsAsUse) {
        this.db
          .prepare(
            'UPDATE entries SET recall_count = recall_count + 1 WHERE id = ?'
          )
          .run(memoryId);
        return;
      }
      if (entry.status === 'active' && entry.decay !== 'fresh') {
        this.updateEntry(
          {
            ...entry,
            decay: 'fresh',
            lastRecalledAt: input.at,
            recallCount: entry.recallCount + 1,
            rev: entry.rev + 1,
          },
          SYSTEM_ADDRESS,
          'decay'
        );
        return;
      }
      this.db
        .prepare(
          'UPDATE entries SET last_recalled_at = ?, recall_count = recall_count + 1 WHERE id = ?'
        )
        .run(input.at, memoryId);
    });
  }

  recallsForRun(runId: string): RecallRow[] {
    return queryAll<{
      memory_id: string;
      run_id: string;
      via: string;
      at: string;
    }>(
      this.db,
      'SELECT * FROM recalls WHERE run_id = ? ORDER BY at, memory_id',
      [runId]
    ).map((r) => ({
      memoryId: r.memory_id,
      runId: r.run_id,
      via: r.via as RecallVia,
      at: r.at,
    }));
  }

  pruneRecalls(beforeIso: string): number {
    return Number(
      this.db.prepare('DELETE FROM recalls WHERE at < ?').run(beforeIso).changes
    );
  }

  isTombstoned(origin: string): boolean {
    return (
      queryOne(
        this.db,
        'SELECT 1 AS one FROM deleted_origins WHERE origin = ?',
        [origin]
      ) !== undefined
    );
  }

  meta(key: string): string | null {
    return (
      queryOne<{ value: string }>(
        this.db,
        'SELECT value FROM meta WHERE key = ?',
        [key]
      )?.value ?? null
    );
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run(key, value);
  }

  deleteMeta(key: string): void {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  }

  countEntries(): number {
    return (
      queryOne<{ n: number }>(this.db, 'SELECT COUNT(*) AS n FROM entries')
        ?.n ?? 0
    );
  }

  appendActivity(row: ActivityRow): void {
    this.db
      .prepare(
        'INSERT INTO activity (id, at, kind, memory_id, run_id, summary) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(row.id, row.at, row.kind, row.memoryId, row.runId, row.summary);
  }

  activitySince(sinceIso: string, limit: number): ActivityRow[] {
    return queryAll<{
      id: string;
      at: string;
      kind: string;
      memory_id: string | null;
      run_id: string | null;
      summary: string;
    }>(
      this.db,
      'SELECT * FROM activity WHERE at > ? ORDER BY at DESC, id DESC LIMIT ?',
      [sinceIso, limit]
    ).map((r) => ({
      id: r.id,
      at: r.at,
      kind: r.kind as ActivityRow['kind'],
      memoryId: r.memory_id,
      runId: r.run_id,
      summary: r.summary,
    }));
  }

  hasActivitySince(kind: ActivityRow['kind'], sinceIso: string): boolean {
    return (
      queryOne(
        this.db,
        'SELECT 1 AS one FROM activity WHERE kind = ? AND at > ? LIMIT 1',
        [kind, sinceIso]
      ) !== undefined
    );
  }

  countRevisionsBy(
    by: Address,
    sinceIso: string,
    causes: readonly RevisionCause[]
  ): number {
    if (causes.length === 0) return 0;
    return (
      queryOne<{ n: number }>(
        this.db,
        `SELECT COUNT(*) AS n FROM revisions WHERE by_addr = ? AND at > ? AND cause IN (${causes.map(() => '?').join(', ')})`,
        [by, sinceIso, ...causes]
      )?.n ?? 0
    );
  }

  insertProposal(p: MemoryProposal): void {
    this.db
      .prepare(
        `INSERT INTO proposals (${PROPOSAL_COLUMNS.join(', ')}) VALUES (${PROPOSAL_COLUMNS.map(() => '?').join(', ')})`
      )
      .run(...proposalParams(p));
  }

  updateProposal(p: MemoryProposal): void {
    const sets = PROPOSAL_COLUMNS.filter((c) => c !== 'id')
      .map((c) => `${c} = ?`)
      .join(', ');
    this.db
      .prepare(`UPDATE proposals SET ${sets} WHERE id = ?`)
      .run(...proposalParams(p).slice(1), p.id);
  }

  getProposal(id: string): MemoryProposal | null {
    const row = queryOne<ProposalRow>(
      this.db,
      'SELECT * FROM proposals WHERE id = ?',
      [id]
    );
    return row === undefined ? null : proposalFromRow(row);
  }

  proposalByOrigin(origin: string): MemoryProposal | null {
    const row = queryOne<ProposalRow>(
      this.db,
      'SELECT * FROM proposals WHERE origin = ?',
      [origin]
    );
    return row === undefined ? null : proposalFromRow(row);
  }

  listProposals(filter: { states?: ProposalState[] } = {}): MemoryProposal[] {
    const states = filter.states;
    const where =
      states === undefined
        ? ''
        : ` WHERE state IN (${states.map(() => '?').join(', ')})`;
    return queryAll<ProposalRow>(
      this.db,
      `SELECT * FROM proposals${where} ORDER BY created_at, id`,
      states ?? []
    ).map(proposalFromRow);
  }

  countOpenProposals(): number {
    return (
      queryOne<{ n: number }>(
        this.db,
        "SELECT COUNT(*) AS n FROM proposals WHERE state = 'open'"
      )?.n ?? 0
    );
  }

  entriesByContentHash(
    hash: string,
    scopes: readonly MemoryScope[]
  ): MemoryEntry[] {
    if (scopes.length === 0) return [];
    return queryAll<EntryRow>(
      this.db,
      `SELECT * FROM entries e WHERE e.content_hash = ? AND e.scope IN (${scopes.map(() => '?').join(', ')}) ORDER BY e.seq`,
      [hash, ...scopes]
    ).map(entryFromRow);
  }

  proposalsByContentHash(hash: string): MemoryProposal[] {
    return queryAll<ProposalRow>(
      this.db,
      'SELECT * FROM proposals WHERE content_hash = ? ORDER BY created_at, id',
      [hash]
    ).map(proposalFromRow);
  }

  openRetireFor(target: string): MemoryProposal | null {
    const row = queryOne<ProposalRow>(
      this.db,
      "SELECT * FROM proposals WHERE target = ? AND action = 'retire' AND state = 'open' ORDER BY created_at, id LIMIT 1",
      [target]
    );
    return row === undefined ? null : proposalFromRow(row);
  }

  // Ledger-import and sync proposals are bounded by what arrives, so they never count.
  countProposalsBy(author: Address, sinceIso: string): number {
    return (
      queryOne<{ n: number }>(
        this.db,
        `SELECT COUNT(*) AS n FROM proposals WHERE author = ? AND created_at > ?
         AND (origin IS NULL OR (origin NOT GLOB 'ledger:*' AND origin NOT GLOB 'sync:*'))`,
        [author, sinceIso]
      )?.n ?? 0
    );
  }

  manifest(lineage: string): ManifestRow[] {
    return queryAll<ExportRow>(
      this.db,
      'SELECT * FROM exports WHERE lineage = ? ORDER BY file',
      [lineage]
    ).map(manifestFromRow);
  }

  replaceManifest(lineage: string, rows: readonly ManifestRow[]): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM exports WHERE lineage = ?').run(lineage);
      const insert = this.db.prepare(PUT_MANIFEST_ROW);
      for (const row of rows)
        insert.run(...manifestParams({ ...row, lineage }));
    });
  }

  putManifestRow(row: ManifestRow): void {
    this.db.prepare(PUT_MANIFEST_ROW).run(...manifestParams(row));
  }

  deleteManifestRow(lineage: string, file: string): void {
    this.db
      .prepare('DELETE FROM exports WHERE lineage = ? AND file = ?')
      .run(lineage, file);
  }

  manifestLineages(): string[] {
    return queryAll<{ lineage: string }>(
      this.db,
      'SELECT DISTINCT lineage FROM exports ORDER BY lineage'
    ).map((r) => r.lineage);
  }

  addIngestProblem(row: IngestProblemRow): void {
    this.db
      .prepare(
        'INSERT INTO ingest_problems (id, lineage, file, reason, size, sha256, content, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        row.id,
        row.lineage,
        row.file,
        row.reason,
        row.size,
        row.sha256,
        row.content,
        row.at
      );
  }

  ingestProblems(limit: number): IngestProblem[] {
    return queryAll<IngestProblem>(
      this.db,
      'SELECT id, lineage, file, reason, size, at FROM ingest_problems ORDER BY at DESC, id DESC LIMIT ?',
      [limit]
    );
  }

  takeIngestProblem(id: string): IngestProblemRow | null {
    return this.transaction(() => {
      const row = queryOne<IngestProblemRow>(
        this.db,
        'SELECT id, lineage, file, reason, size, sha256, content, at FROM ingest_problems WHERE id = ?',
        [id]
      );
      if (row === undefined) return null;
      this.db.prepare('DELETE FROM ingest_problems WHERE id = ?').run(id);
      return row;
    });
  }

  // One generation of backup: VACUUM INTO refuses an existing target and any
  // open transaction, so it writes a fresh temporary file and renames it over.
  backup(path: string): void {
    const tmp = `${path}.tmp`;
    rmSync(tmp, { force: true });
    this.db.prepare('VACUUM INTO ?').run(tmp);
    const fd = openSync(tmp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }

  close(): void {
    this.db.close();
  }

  private appendRevision(
    entry: MemoryEntry,
    by: Address,
    cause: RevisionCause
  ): void {
    this.db
      .prepare(
        'INSERT INTO revisions (memory_id, rev, snapshot_json, by_addr, cause, at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        entry.id,
        entry.rev,
        JSON.stringify(entry),
        by,
        cause,
        new Date().toISOString()
      );
  }
}

const PUT_MANIFEST_ROW =
  'INSERT OR REPLACE INTO exports (lineage, file, store, memory_id, rev, parsed_hash) VALUES (?, ?, ?, ?, ?, ?)';

interface ExportRow {
  lineage: string;
  file: string;
  store: string;
  memory_id: string;
  rev: number;
  parsed_hash: string;
}

function manifestParams(r: ManifestRow): SqlValue[] {
  return [r.lineage, r.file, r.store, r.memoryId, r.rev, r.parsedHash];
}

function manifestFromRow(r: ExportRow): ManifestRow {
  return {
    lineage: r.lineage,
    file: r.file,
    store: r.store,
    memoryId: r.memory_id,
    rev: r.rev,
    parsedHash: r.parsed_hash,
  };
}

const PROPOSAL_COLUMNS = [
  'id',
  'action',
  'scope',
  'target',
  'base_rev',
  'content_json',
  'reason',
  'author',
  'author_trust',
  'operator',
  'run_id',
  'task_id',
  'origin',
  'content_hash',
  'gate_id',
  'state',
  'matched_personal',
  'decided_by',
  'decided_by_policy',
  'decision_reason',
  'result_id',
  'created_at',
  'decided_at',
] as const;

interface ProposalRow {
  id: string;
  action: string;
  scope: string;
  target: string | null;
  base_rev: number | null;
  content_json: string | null;
  reason: string | null;
  author: string;
  author_trust: string;
  operator: string | null;
  run_id: string | null;
  task_id: string | null;
  origin: string | null;
  content_hash: string | null;
  gate_id: string | null;
  state: string;
  matched_personal: number;
  decided_by: string | null;
  decided_by_policy: string | null;
  decision_reason: string | null;
  result_id: string | null;
  created_at: string;
  decided_at: string | null;
}

// The values of PROPOSAL_COLUMNS, in order; content and policy decision as JSON text.
function proposalParams(p: MemoryProposal): SqlValue[] {
  return [
    p.id,
    p.action,
    p.scope,
    p.target,
    p.baseRev,
    p.content === null ? null : JSON.stringify(p.content),
    p.reason,
    p.author,
    p.authorTrust,
    p.operator,
    p.runId,
    p.taskId,
    p.origin,
    p.contentHash,
    p.gate,
    p.state,
    p.matchedPersonal ? 1 : 0,
    p.decidedBy,
    p.decidedByPolicy === null ? null : JSON.stringify(p.decidedByPolicy),
    p.decisionReason,
    p.result,
    p.createdAt,
    p.decidedAt,
  ];
}

function proposalFromRow(r: ProposalRow): MemoryProposal {
  return {
    id: r.id,
    action: r.action as MemoryProposal['action'],
    scope: r.scope as MemoryProposal['scope'],
    target: r.target,
    baseRev: r.base_rev,
    content:
      r.content_json === null
        ? null
        : (JSON.parse(r.content_json) as MemoryProposal['content']),
    reason: r.reason,
    author: r.author,
    authorTrust: r.author_trust as MemoryProposal['authorTrust'],
    operator: r.operator,
    runId: r.run_id,
    taskId: r.task_id,
    origin: r.origin,
    contentHash: r.content_hash,
    gate: r.gate_id,
    state: r.state as MemoryProposal['state'],
    matchedPersonal: r.matched_personal === 1,
    decidedBy: r.decided_by,
    decidedByPolicy:
      r.decided_by_policy === null
        ? null
        : (JSON.parse(
            r.decided_by_policy
          ) as MemoryProposal['decidedByPolicy']),
    decisionReason: r.decision_reason,
    result: r.result_id,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}
