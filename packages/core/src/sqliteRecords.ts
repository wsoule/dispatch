import type { DatabaseSync } from 'node:sqlite';

import type { CommandEvidence, MutationEvidence } from './evidence.js';
import {
  FINDING_RECOMMENDATIONS,
  FINDING_SEVERITIES,
  FINDING_VERDICTS,
} from './findings.js';
import type {
  AddFindingInput,
  Finding,
  FindingListFilter,
  FindingRecommendation,
  FindingSeverity,
  FindingUpdatePatch,
  FindingVerdict,
} from './findings.js';
import { generateFindingId, generateLedgerId } from './ids.js';
import { LEDGER_KINDS } from './ledger.js';
import type {
  AddLedgerInput,
  LedgerEntry,
  LedgerKind,
  LedgerListFilter,
} from './ledger.js';
import {
  parseEnum,
  parseStringArray,
  queryAll,
  queryOne,
  serializeStringArray,
} from './sqliteDb.js';

// The database-backed counterparts of the daemon's three JSONL sidecars:
// `.dispatch/findings.jsonl`, `.dispatch/ledger.jsonl`, and the evidence lines
// interleaved into each run's transcript. Decisions are ledger rows with
// `kind: 'decision'` — the same modelling the file-backed stores use — so
// there is no separate decisions table.
//
// One contract deliberately differs. The JSONL stores are append-only: an
// update is a fresh line, reads compact by `id + createdAt`, and two records
// that happened to mint the same id both survive because the file cannot
// enforce otherwise. Here the id is a primary key, so an update rewrites its
// row and a duplicate id is impossible by construction rather than tolerated
// after the fact. Nothing reads the superseded lines today; what callers see
// is the same latest-record-wins view.

// How many ids add() tries before giving up. Matches the JSONL stores'
// MINT_ATTEMPTS: far beyond what randomness needs, it only bounds a generator
// that keeps returning a taken id.
const MINT_ATTEMPTS = 32;

/**
 * Writes a record under a freshly minted id, re-rolling when the write reports
 * the id was already taken.
 *
 * The collision check is the INSERT itself — `ON CONFLICT DO NOTHING`, then
 * `changes` — rather than a SELECT asked beforehand. The daemon and the CLI
 * share one database file, so anything asked before the write can be stale by
 * the time the write lands, and losing that race here would mean silently
 * replacing someone else's record instead of minting a second id.
 *
 * `attemptInsert` returns the record on success and null when the id was
 * taken.
 */
function withMintedId<T>(
  label: string,
  generateId: (now: string) => string,
  now: string,
  attemptInsert: (id: string) => T | null
): T {
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
    const written = attemptInsert(generateId(now));
    if (written !== null) return written;
  }
  throw new Error(
    `could not mint an unused ${label} id in ${MINT_ATTEMPTS} attempts`
  );
}

interface FindingRow {
  id: string;
  task_id: string;
  run_id: string | null;
  severity: string;
  verdict: string;
  title: string;
  detail: string;
  file: string | null;
  line: number | null;
  files: string | null;
  ruling: string | null;
  recommendation: string | null;
  round: number;
  created_at: string;
  updated_at: string;
  raised_by: string;
}

// `files` and `recommendation` are spread rather than assigned so a finding
// raised without them keeps exactly the shape it had before either field
// existed — the JSON a reviewer sees stays byte-comparable across backends.
// The closed-set columns are checked rather than cast: a damaged `verdict`
// read straight through would hand the fix loop a state it has no branch for.
function findingFromRow(row: FindingRow): Finding {
  const id = row.id;
  return {
    id,
    taskId: row.task_id,
    runId: row.run_id,
    severity: parseEnum<FindingSeverity>(
      row.severity,
      FINDING_SEVERITIES,
      'findings',
      id,
      'severity'
    ),
    verdict: parseEnum<FindingVerdict>(
      row.verdict,
      FINDING_VERDICTS,
      'findings',
      id,
      'verdict'
    ),
    title: row.title,
    detail: row.detail,
    file: row.file,
    line: row.line,
    ...(row.files === null
      ? {}
      : { files: parseStringArray(row.files, 'findings', id, 'files') }),
    ruling: row.ruling,
    ...(row.recommendation === null
      ? {}
      : {
          recommendation: parseEnum<FindingRecommendation>(
            row.recommendation,
            FINDING_RECOMMENDATIONS,
            'findings',
            id,
            'recommendation'
          ),
        }),
    round: row.round,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    raisedBy: row.raised_by,
  };
}

const INSERT_FINDING_IF_ABSENT = `
INSERT INTO findings (
  id, task_id, run_id, severity, verdict, title, detail, file, line, files,
  ruling, recommendation, round, created_at, updated_at, raised_by
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO NOTHING
`;

// A verdict/ruling change touches three columns, so it is spelled as those
// three columns. Rewriting all sixteen would let a stale in-memory copy of the
// record quietly reinstate fields another writer had already moved on from.
const UPDATE_FINDING_RULING = `
UPDATE findings SET verdict = ?, ruling = ?, updated_at = ? WHERE id = ?
`;

export class SqliteFindingStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly generateId: (now: string) => string = generateFindingId
  ) {}

  get(id: string): Finding | null {
    const row = queryOne<FindingRow>(
      this.db,
      'SELECT * FROM findings WHERE id = ?',
      [id]
    );
    return row === undefined ? null : findingFromRow(row);
  }

  list(filter: FindingListFilter = {}): Finding[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.taskId !== undefined) {
      clauses.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (filter.verdict !== undefined) {
      clauses.push('verdict = ?');
      params.push(filter.verdict);
    }
    if (filter.severity !== undefined) {
      clauses.push('severity = ?');
      params.push(filter.severity);
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    // Insertion order, which is what reading a JSONL file front to back gives.
    return queryAll<FindingRow>(
      this.db,
      `SELECT * FROM findings${where} ORDER BY rowid`,
      params
    ).map(findingFromRow);
  }

  /** The findings still blocking a task's fix loop. */
  openFor(taskId: string): Finding[] {
    return this.list({ taskId, verdict: 'open' });
  }

  add(input: AddFindingInput, now: string = new Date().toISOString()): Finding {
    return withMintedId('finding', this.generateId, now, (id) => {
      const record: Finding = {
        id,
        taskId: input.taskId,
        runId: input.runId,
        severity: input.severity,
        verdict: 'open',
        title: input.title,
        detail: input.detail,
        file: input.file ?? null,
        line: input.line ?? null,
        ruling: null,
        round: input.round ?? 0,
        createdAt: now,
        updatedAt: now,
        raisedBy: input.raisedBy,
        ...(input.recommendation !== undefined
          ? { recommendation: input.recommendation }
          : {}),
        ...(input.files !== undefined ? { files: input.files } : {}),
      };
      const written = this.db
        .prepare(INSERT_FINDING_IF_ABSENT)
        .run(
          record.id,
          record.taskId,
          record.runId,
          record.severity,
          record.verdict,
          record.title,
          record.detail,
          record.file,
          record.line,
          record.files === undefined
            ? null
            : serializeStringArray(record.files),
          record.ruling,
          record.recommendation ?? null,
          record.round,
          record.createdAt,
          record.updatedAt,
          record.raisedBy
        );
      return written.changes > 0 ? record : null;
    });
  }

  update(
    id: string,
    patch: FindingUpdatePatch,
    now: string = new Date().toISOString()
  ): Finding {
    const existing = this.get(id);
    if (existing === null) throw new Error(`finding not found: ${id}`);
    const verdict = patch.verdict ?? existing.verdict;
    const ruling = patch.ruling !== undefined ? patch.ruling : existing.ruling;
    this.db.prepare(UPDATE_FINDING_RULING).run(verdict, ruling, now, id);
    return { ...existing, verdict, ruling, updatedAt: now };
  }
}

interface LedgerRow {
  id: string;
  epic_id: string | null;
  source_task_id: string | null;
  kind: string;
  title: string;
  detail: string;
  applies_to: string;
  created_at: string;
  authored_by: string;
}

// `applies_to` is checked rather than defaulted for the same reason a task's
// `blocked_by` is: an entry aimed at one task reads as an entry aimed at every
// task under its epic the moment that column comes back empty.
function ledgerFromRow(row: LedgerRow): LedgerEntry {
  const id = row.id;
  return {
    id,
    epicId: row.epic_id,
    sourceTaskId: row.source_task_id,
    kind: parseEnum<LedgerKind>(
      row.kind,
      LEDGER_KINDS,
      'ledger_entries',
      id,
      'kind'
    ),
    title: row.title,
    detail: row.detail,
    appliesTo: parseStringArray(
      row.applies_to,
      'ledger_entries',
      id,
      'applies_to'
    ),
    createdAt: row.created_at,
    authoredBy: row.authored_by,
  };
}

const INSERT_LEDGER_IF_ABSENT = `
INSERT INTO ledger_entries (
  id, epic_id, source_task_id, kind, title, detail, applies_to,
  created_at, authored_by
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO NOTHING
`;

export class SqliteLedgerStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly generateId: (now: string) => string = generateLedgerId
  ) {}

  add(
    input: AddLedgerInput,
    now: string = new Date().toISOString()
  ): LedgerEntry {
    return withMintedId('ledger', this.generateId, now, (id) => {
      const record: LedgerEntry = {
        id,
        epicId: input.epicId ?? null,
        sourceTaskId: input.sourceTaskId ?? null,
        kind: input.kind,
        title: input.title,
        detail: input.detail,
        appliesTo: input.appliesTo ?? [],
        createdAt: now,
        authoredBy: input.authoredBy,
      };
      const written = this.db
        .prepare(INSERT_LEDGER_IF_ABSENT)
        .run(
          record.id,
          record.epicId,
          record.sourceTaskId,
          record.kind,
          record.title,
          record.detail,
          serializeStringArray(record.appliesTo),
          record.createdAt,
          record.authoredBy
        );
      return written.changes > 0 ? record : null;
    });
  }

  get(id: string): LedgerEntry | null {
    const row = queryOne<LedgerRow>(
      this.db,
      'SELECT * FROM ledger_entries WHERE id = ?',
      [id]
    );
    return row === undefined ? null : ledgerFromRow(row);
  }

  // `epicId: null` is a real filter (project-wide entries), distinct from an
  // omitted filter (everything), so the null case becomes `IS NULL` rather
  // than a parameter — `epic_id = ?` never matches NULL in SQL.
  list(filter: LedgerListFilter = {}): LedgerEntry[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.epicId === null) {
      clauses.push('epic_id IS NULL');
    } else if (filter.epicId !== undefined) {
      clauses.push('epic_id = ?');
      params.push(filter.epicId);
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    return queryAll<LedgerRow>(
      this.db,
      `SELECT * FROM ledger_entries${where} ORDER BY rowid`,
      params
    ).map(ledgerFromRow);
  }

  /**
   * What a dispatched task should see: entries aimed at it directly, plus
   * untargeted entries scoped to its epic or project-wide (epicId null).
   *
   * `appliesTo` is a JSON array column, so the membership half is filtered in
   * TypeScript; the volumes involved are a project's ledger, not a log.
   */
  entriesFor(taskId: string, epicId: string | null): LedgerEntry[] {
    return this.list().filter(
      (e) =>
        e.appliesTo.includes(taskId) ||
        (e.appliesTo.length === 0 && (e.epicId === null || e.epicId === epicId))
    );
  }
}

/**
 * The commands a run actually ran and the guards it mutation-tested, keyed by
 * run id. These live in each run's transcript JSONL today; the run itself is
 * still orchestrator state, so `run_id` is an opaque key here rather than a
 * foreign key — nothing in this database owns runs yet.
 *
 * Ordering is explicit (`seq`) rather than implied by rowid, because a run's
 * evidence is read back as a numbered list in the order it was recorded. The
 * next sequence number is computed inside the INSERT rather than read first:
 * two writers on one run would otherwise both read the same MAX and collide on
 * the primary key.
 */
interface EvidenceRow {
  command: string;
  exit_code: number;
  duration_ms: number;
  summary: string;
  at: string;
}

interface MutationRow {
  guard: string;
  file: string;
  tests_failed: number;
  at: string;
}

const INSERT_EVIDENCE = `
INSERT INTO evidence (run_id, seq, command, exit_code, duration_ms, summary, at)
VALUES (
  ?,
  (SELECT COALESCE(MAX(seq) + 1, 0) FROM evidence WHERE run_id = ?),
  ?, ?, ?, ?, ?
)
`;

const INSERT_MUTATION = `
INSERT INTO mutations (run_id, seq, guard, file, tests_failed, at)
VALUES (
  ?,
  (SELECT COALESCE(MAX(seq) + 1, 0) FROM mutations WHERE run_id = ?),
  ?, ?, ?, ?
)
`;

export class SqliteEvidenceStore {
  constructor(private readonly db: DatabaseSync) {}

  addCommand(runId: string, evidence: CommandEvidence): CommandEvidence {
    this.db
      .prepare(INSERT_EVIDENCE)
      .run(
        runId,
        runId,
        evidence.command,
        evidence.exitCode,
        evidence.durationMs,
        evidence.summary,
        evidence.at
      );
    return evidence;
  }

  addMutation(runId: string, mutation: MutationEvidence): MutationEvidence {
    this.db
      .prepare(INSERT_MUTATION)
      .run(
        runId,
        runId,
        mutation.guard,
        mutation.file,
        mutation.testsFailed,
        mutation.at
      );
    return mutation;
  }

  commandsFor(runId: string): CommandEvidence[] {
    const rows = queryAll<EvidenceRow>(
      this.db,
      `SELECT command, exit_code, duration_ms, summary, at
       FROM evidence WHERE run_id = ? ORDER BY seq`,
      [runId]
    );
    return rows.map((row) => ({
      command: row.command,
      exitCode: row.exit_code,
      durationMs: row.duration_ms,
      summary: row.summary,
      at: row.at,
    }));
  }

  mutationsFor(runId: string): MutationEvidence[] {
    const rows = queryAll<MutationRow>(
      this.db,
      `SELECT guard, file, tests_failed, at
       FROM mutations WHERE run_id = ? ORDER BY seq`,
      [runId]
    );
    return rows.map((row) => ({
      guard: row.guard,
      file: row.file,
      testsFailed: row.tests_failed,
      at: row.at,
    }));
  }
}
