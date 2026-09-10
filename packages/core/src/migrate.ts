import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FINDING_RECOMMENDATIONS,
  FINDING_SEVERITIES,
  FINDING_VERDICTS,
} from './findings.js';
import type { Finding } from './findings.js';
import { isTaskId } from './ids.js';
import { scanFindingsJsonl, scanLedgerJsonl } from './jsonlRecords.js';
import { LEDGER_KINDS } from './ledger.js';
import type { LedgerEntry } from './ledger.js';
import { queryOne } from './sqliteDb.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { DISPATCH_DIR, TaskStore } from './store.js';
import type { ProjectStores, SqliteRecordStores } from './storeBackend.js';

// The one-time import that moves a project's file-backed state — the markdown
// task board under `.dispatch/tasks` and the append-only JSONL sidecars beside
// it — into the daemon's SQLite database.
//
// This lives in `@dispatch/core` rather than in the daemon for one hard
// reason: `@dispatch/cli` must stay Node-runnable and cannot import
// `@dispatch/server` at all (it is Bun-only and publishes no root export — the
// CLI only resolves its package.json to find a script to spawn). Both the
// daemon's boot-time auto-import and `dispatch migrate` need this code, and
// core is the only package both of them can load.
//
// THREE PROPERTIES THIS IS BUILT AROUND, all of them load-bearing:
//
// 1. Non-destructive. Nothing here deletes or rewrites a source file.
//    Retiring the originals is a separate task, and exporting them to the git
//    receipt log is another; both need this import to be independently
//    revertible, which it only is while the originals are still on disk.
//
// 2. Idempotent, via INSERT ... ON CONFLICT DO NOTHING on the records' own
//    ids — never by consuming the source. A second pass adds nothing rather
//    than overwriting a record the daemon has since ruled on. That is why ids
//    and timestamps are preserved verbatim (put(), not add()/create()): they
//    are the idempotency key, and they are also quoted by task activity, by
//    fix-loop state, and by other tasks' ledger entries.
//
// 3. All-or-nothing. The whole import runs in one transaction, so a failure
//    partway leaves an empty database and every source file untouched — which
//    means the project's real board is still the markdown on disk. That is
//    also what makes a dry run honest: it does the real import and rolls back.

/** The sources whose presence means a project still keeps state as files. */
export const LEGACY_SOURCES = [
  `${DISPATCH_DIR}/tasks`,
  `${DISPATCH_DIR}/findings.jsonl`,
  `${DISPATCH_DIR}/ledger.jsonl`,
] as const;

/** What happened to one record type. */
export interface MigrationTally {
  /** Records the file backend serves today. */
  found: number;
  /** Rows this pass inserted. */
  imported: number;
  /** Records the database already held under that id, so left alone. */
  skipped: number;
  /** Records that could not be read, or that would not read back. */
  damaged: number;
}

/** One record the import could not take, and why. */
export interface MigrationProblem {
  source: string;
  detail: string;
}

/**
 * A file-backed source this import deliberately does NOT move, counted anyway.
 *
 * `.dispatch/fix-loops.jsonl`, `.dispatch/notes.json` and `.dispatch/inbox`
 * have no table in the daemon schema — the database backend serves all three
 * from files regardless of backend today. Run transcripts are a separate case:
 * they hold the command and mutation evidence, but they live outside the
 * project entirely, under `~/.dispatch/runs/`, and core has no handle on them.
 *
 * All of them are still counted and still printed. A report that says "185
 * tasks moved" and never mentions the notes sitting beside them reads as a
 * complete migration when it is not, and that misreading is the failure mode
 * worth ruling out — somebody deleting the originals afterwards would lose
 * them.
 */
export interface RetainedSource {
  source: string;
  found: number;
  reason: string;
}

/** Row counts per table, used on both sides of the import for parity. */
export interface RowCounts {
  tasks: number;
  epics: number;
  findings: number;
  ledger: number;
}

export interface MigrationReport {
  rootDir: string;
  dryRun: boolean;
  tasks: MigrationTally;
  epics: MigrationTally;
  findings: MigrationTally;
  ledger: MigrationTally;
  problems: MigrationProblem[];
  retained: RetainedSource[];
  /**
   * Row counts read out of the database before and after the import, inside
   * the same transaction. Deliberately a real query rather than a running
   * total of what the loops believe they wrote: a total computed from the
   * same variables that drove the writes cannot disagree with them, so it
   * proves nothing. `rowsBefore + imported === rowsAfter` is the parity check
   * formatMigrationReport flags when it fails.
   */
  rowsBefore: RowCounts;
  rowsAfter: RowCounts;
}

export interface ImportOptions {
  /** Do the whole import, report it, then roll it back. */
  dryRun?: boolean;
  /**
   * Where the `.dispatch/` tree to read from lives. Defaults to the target
   * project's own root, which is what the boot-time import wants: source and
   * destination are the same project.
   *
   * The receipt exporter is why this is separable. Its log is laid out as a
   * file-backed project precisely so restoring it is this import pointed
   * somewhere else, rather than a second deserializer that could drift from
   * this one — and restoring means reading from the log while writing into a
   * rebuilt database elsewhere.
   */
  sourceDir?: string;
}

/**
 * Whether a project still has file-backed state this import would move.
 *
 * Only the three importable sources count. An inbox or a notes file on its own
 * is not legacy state as far as this is concerned: the import does not move
 * them, so treating them as work to do would make the daemon log an
 * all-zeroes report on every boot, forever.
 */
export function hasLegacyState(rootDir: string): boolean {
  return LEGACY_SOURCES.some((source) => existsSync(join(rootDir, source)));
}

/** Records actually inserted, across every table. */
export function totalImported(report: MigrationReport): number {
  return (
    report.tasks.imported +
    report.epics.imported +
    report.findings.imported +
    report.ledger.imported
  );
}

function emptyTally(): MigrationTally {
  return { found: 0, imported: 0, skipped: 0, damaged: 0 };
}

/**
 * The slug each task's FILE actually uses, read from the directory once.
 *
 * Not `slugify(title)`: retitling a task rewrites its frontmatter but never
 * renames its file, so a long-lived task's filename can carry a slug its title
 * no longer produces. Preserving the real one keeps `toMarkdown()` — the
 * export half of the seam, and how these rows reach the git receipt log —
 * round-tripping to the filename this project already has committed.
 *
 * Read in one pass rather than via `taskFilePath()` per task, which re-scans
 * the directory on every call and would turn a 185-task board into 185 scans.
 */
function taskSlugsByFile(tasksDir: string): Map<string, string> {
  const slugs = new Map<string, string>();
  if (!existsSync(tasksDir)) return slugs;
  for (const file of readdirSync(tasksDir)) {
    if (!file.endsWith('.md')) continue;
    const name = file.slice(0, -'.md'.length);
    // Ids are `<t|e>-<6 hex>`, so the id is the first 8 characters and the
    // slug is whatever follows the separating dash. Splitting on the first
    // dash instead would cut the id itself in half.
    const id = name.slice(0, 8);
    if (!isTaskId(id)) continue;
    if (name.length === id.length) slugs.set(id, '');
    else if (name[id.length] === '-') slugs.set(id, name.slice(id.length + 1));
  }
  return slugs;
}

function rowCounts(records: SqliteRecordStores): RowCounts {
  const count = (sql: string, params: string[] = []): number =>
    queryOne<{ n: number }>(records.db, sql, params)?.n ?? 0;
  return {
    tasks: count('SELECT COUNT(*) AS n FROM tasks WHERE kind = ?', ['task']),
    epics: count('SELECT COUNT(*) AS n FROM tasks WHERE kind = ?', ['epic']),
    findings: count('SELECT COUNT(*) AS n FROM findings'),
    ledger: count('SELECT COUNT(*) AS n FROM ledger_entries'),
  };
}

/**
 * Why a record would not survive a round trip through the database.
 *
 * Enum columns are checked on the way back OUT of SQLite (see parseEnum), so a
 * value outside its set inserts happily and then throws on every read. Catching
 * it here costs one comparison; not catching it mints a row nothing can ever
 * read again, in the middle of the one import that was supposed to preserve
 * this project's history.
 */
function unreadableFinding(record: Finding): string | null {
  if (!FINDING_SEVERITIES.includes(record.severity)) {
    return `severity '${record.severity}' is outside the set`;
  }
  if (!FINDING_VERDICTS.includes(record.verdict)) {
    return `verdict '${record.verdict}' is outside the set`;
  }
  if (
    record.recommendation !== undefined &&
    !FINDING_RECOMMENDATIONS.includes(record.recommendation)
  ) {
    return `recommendation '${record.recommendation}' is outside the set`;
  }
  if (
    record.files !== undefined &&
    (!Array.isArray(record.files) ||
      record.files.some((f) => typeof f !== 'string'))
  ) {
    return 'files is not a list of strings';
  }
  return null;
}

function unreadableLedgerEntry(record: LedgerEntry): string | null {
  if (!LEDGER_KINDS.includes(record.kind)) {
    return `kind '${record.kind}' is outside the set`;
  }
  return null;
}

// Distinct tasks with fix-loop state; the file is last-write-wins per task, so
// three writes about one task are one loop, not three.
function countFixLoops(rootDir: string): number {
  const file = join(rootDir, DISPATCH_DIR, 'fix-loops.jsonl');
  if (!existsSync(file)) return 0;
  const taskIds = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as { taskId?: unknown };
      if (typeof parsed.taskId === 'string') taskIds.add(parsed.taskId);
    } catch {
      // A corrupt line is not a fix loop to report; the store skips it too.
    }
  }
  return taskIds.size;
}

// Notes are a single JSON array, whole-file rewritten on every mutation.
function countNotes(rootDir: string): number {
  const file = join(rootDir, DISPATCH_DIR, 'notes.json');
  if (!existsSync(file)) return 0;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

// Inbox items across every actor's file. The inbox is a hand-editable markdown
// checklist, one file per actor, and an item is exactly a `- [ ]` / `- [x]`
// line — the same shape its own parser keys on.
function countInboxItems(rootDir: string): number {
  const dir = join(rootDir, DISPATCH_DIR, 'inbox');
  if (!existsSync(dir)) return 0;
  let items = 0;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (/^- \[[ xX]\]/.test(line)) items += 1;
    }
  }
  return items;
}

/**
 * Exported for retire.ts, which has to print the same list for the opposite
 * reason: the import names these to say "not moved", and the retirement names
 * them to say "not deleted, because nothing else holds them".
 */
export function retainedSources(rootDir: string): RetainedSource[] {
  return [
    {
      source: `${DISPATCH_DIR}/fix-loops.jsonl`,
      found: countFixLoops(rootDir),
      reason: 'fix-loop state has no table in the schema yet',
    },
    {
      source: `${DISPATCH_DIR}/notes.json`,
      found: countNotes(rootDir),
      reason: 'the notes store is still file-backed on both backends',
    },
    {
      source: `${DISPATCH_DIR}/inbox`,
      found: countInboxItems(rootDir),
      reason:
        'inboxes are per-actor markdown, still file-backed on both backends',
    },
    {
      source: '~/.dispatch/runs/<project>/*.jsonl',
      found: 0,
      reason:
        'not counted here — run transcripts carry the command and mutation evidence, and they live outside the project entirely',
    },
  ];
}

// Imports the markdown board, splitting the tally by kind. A file that will
// not parse becomes a problem rather than aborting the run — listSafe() is
// exactly that seam on the file backend, and a board with one hand-mangled
// file must still be movable.
function importTasks(
  source: TaskStore,
  target: SqliteTaskStore,
  tasks: MigrationTally,
  epics: MigrationTally,
  problems: MigrationProblem[]
): void {
  if (!source.isInitialized()) return;
  const { docs, errors } = source.listSafe();
  for (const error of errors) {
    // Attributed to `tasks` rather than split by kind on purpose: a file that
    // failed to parse is a file whose kind nobody knows.
    tasks.damaged += 1;
    problems.push({
      source: `${DISPATCH_DIR}/tasks/${error.file}`,
      detail: `${error.file}: ${error.message}`,
    });
  }
  const slugs = taskSlugsByFile(source.tasksDir);
  for (const doc of docs) {
    const tally = doc.meta.kind === 'epic' ? epics : tasks;
    tally.found += 1;
    // Check-then-write rather than an upsert, because put() OVERWRITES: a
    // re-run must not clobber a task the daemon has edited since the first
    // pass. Safe as two steps here in a way it would not be in the daemon's
    // request path — the import holds a transaction, and on the boot path it
    // runs before the server serves anything.
    if (target.get(doc.meta.id) !== null) {
      tally.skipped += 1;
      continue;
    }
    // An empty slug means the file was `<id>.md` with no slug at all; fall
    // back to the title's slug so the exported filename still reads as
    // something rather than trailing a bare dash.
    const slug = slugs.get(doc.meta.id);
    try {
      target.put(doc, slug === undefined || slug === '' ? undefined : slug);
      tally.imported += 1;
    } catch (err) {
      // put() rejects an id that is not `<t|e>-<6 hex>`, and parseTaskFile
      // does NOT check that pattern — it only requires the field to be
      // present. So one hand-written `id: my-task` in a board of 185 files
      // would throw from here, escape into the transaction's catch, roll the
      // whole import back and (on the boot path) stop the daemon coming up.
      // One unimportable file has to cost itself, exactly like an unparsable
      // one three lines up and like every damaged JSONL record.
      tally.damaged += 1;
      problems.push({
        source: `${DISPATCH_DIR}/tasks`,
        detail: `${doc.meta.id}: ${(err as Error).message}`,
      });
    }
  }
}

// Shared body of the two JSONL imports: both carry their own ids, both are
// idempotent through put()'s ON CONFLICT DO NOTHING, and both have to name a
// record they could not fit rather than letting it vanish.
function importJsonl<T extends { id: string; createdAt: string }>(
  rootDir: string,
  filename: string,
  scan: (text: string) => {
    records: T[];
    unparseableLines: string[];
    invalidLines: string[];
    duplicateIds: string[];
  },
  unreadable: (record: T) => string | null,
  put: (record: T) => boolean,
  tally: MigrationTally,
  problems: MigrationProblem[]
): void {
  const source = `${DISPATCH_DIR}/${filename}`;
  const file = join(rootDir, DISPATCH_DIR, filename);
  if (!existsSync(file)) return;
  const result = scan(readFileSync(file, 'utf8'));
  for (const line of result.unparseableLines) {
    tally.damaged += 1;
    problems.push({
      source,
      detail: `not valid JSON: ${line.slice(0, 120)}`,
    });
  }
  for (const line of result.invalidLines) {
    tally.damaged += 1;
    problems.push({
      source,
      detail: `missing fields every reader dereferences: ${line.slice(0, 120)}`,
    });
  }
  // Ids the FILE itself carries twice, under two different createdAt stamps.
  // The scan reports these precisely so they can be named here.
  const duplicated = new Set(result.duplicateIds);
  const claimedInThisFile = new Map<string, string>();
  for (const record of result.records) {
    tally.found += 1;
    const problem = unreadable(record);
    if (problem !== null) {
      tally.damaged += 1;
      problems.push({ source, detail: `${record.id}: ${problem}` });
      continue;
    }
    // A duplicated id is two DISTINCT records in a file that cannot enforce
    // uniqueness, meeting one primary key in a database that can. Only one of
    // them can exist afterwards, and the loser has to be named: counting it as
    // `skipped` alongside the re-run case would report a real, unrecoverable
    // data loss with the same number that means "nothing to do".
    //
    // Keyed on what the FILE holds, not on what the database answers, so this
    // stays distinct from the ordinary already-present case — a record the
    // database already has from a previous import is a skip, not a problem.
    const claimed = claimedInThisFile.get(record.id);
    if (duplicated.has(record.id) && claimed !== undefined) {
      tally.damaged += 1;
      problems.push({
        source,
        detail:
          `${record.id}: the file holds two different records under this id ` +
          `(kept the one created ${claimed}, dropped the one created ${record.createdAt}). ` +
          'Give the second one a distinct id and re-run to import it.',
      });
      continue;
    }
    // Recorded whether or not the write lands: what matters for the check
    // above is that THIS FILE already presented a record under this id, which
    // is true even when the database had already claimed the row.
    claimedInThisFile.set(record.id, record.createdAt);
    if (put(record)) tally.imported += 1;
    else tally.skipped += 1;
  }
}

/**
 * Imports a project's file-backed state into the database `stores` is already
 * attached to, and reports exactly what moved, what was already there, and
 * what was left behind.
 *
 * Takes an open `ProjectStores` rather than a rootDir because the daemon
 * already holds one: opening a second handle on the same file mid-boot is how
 * you get two writers on a database whose whole point is having one.
 */
export function importLegacyProject(
  stores: ProjectStores,
  options: ImportOptions = {}
): MigrationReport {
  const { dryRun = false } = options;
  const rootDir = stores.tasks.rootDir;
  // Where the files come FROM, which is the project itself unless a caller
  // (the receipts restore) points it elsewhere. `rootDir` stays what the
  // report names, since that is the project the records landed in.
  const sourceDir = options.sourceDir ?? rootDir;
  const records = stores.records;
  // instanceof rather than a cast: `put` is deliberately absent from the
  // TaskStorePort the daemon holds, because importing a record verbatim —
  // keeping its ids and stamps rather than minting them — is not something
  // the file backend should ever be asked to do.
  //
  // The two clauses are load-bearing in different ways, which mutation testing
  // is what surfaced. `records === null` is the one that actually fires: it
  // catches both reachable cases — the file backend, and a sqlite project
  // whose database does not exist yet. The instanceof fires for neither, but
  // removing it fails `tsc`, because it is what narrows `TaskStorePort` to the
  // store that has `put`. A third clause on `stores.backend` was dropped: it
  // was dead both ways.
  if (records === null || !(stores.tasks instanceof SqliteTaskStore)) {
    throw new Error(
      `cannot import into the files backend: ${rootDir} has no dispatch database to import into`
    );
  }
  const target = stores.tasks;

  const tasks = emptyTally();
  const epics = emptyTally();
  const findings = emptyTally();
  const ledger = emptyTally();
  const problems: MigrationProblem[] = [];

  // One transaction around the whole import. A failure partway leaves the
  // database exactly as it was, which is what lets the daemon treat a failed
  // import as "refuse to boot" rather than "half a board is now live"; and it
  // is what makes a dry run report real numbers, since it runs the real
  // import and rolls it back rather than guessing at one.
  records.db.exec('BEGIN');
  let rowsBefore: RowCounts;
  let rowsAfter: RowCounts;
  try {
    rowsBefore = rowCounts(records);
    importTasks(new TaskStore(sourceDir), target, tasks, epics, problems);
    importJsonl(
      sourceDir,
      'findings.jsonl',
      scanFindingsJsonl,
      unreadableFinding,
      (record) => records.findings.put(record),
      findings,
      problems
    );
    importJsonl(
      sourceDir,
      'ledger.jsonl',
      scanLedgerJsonl,
      unreadableLedgerEntry,
      (record) => records.ledger.put(record),
      ledger,
      problems
    );
    // Read inside the transaction, so the report describes the import that
    // happened even when the rollback below undoes it.
    rowsAfter = rowCounts(records);
  } catch (err) {
    records.db.exec('ROLLBACK');
    throw err;
  }
  records.db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');

  return {
    rootDir,
    dryRun,
    tasks,
    epics,
    findings,
    ledger,
    problems,
    retained: retainedSources(sourceDir),
    rowsBefore,
    rowsAfter,
  };
}

// One row per table, in fixed columns so four numbers can be compared down the
// page rather than read out of a sentence.
function tallyCells(
  label: string,
  found: string,
  imported: string,
  present: string,
  damaged: string
): string {
  return (
    `  ${label.padEnd(9)}${found.padStart(5)}${imported.padStart(9)}` +
    `${present.padStart(8)}${damaged.padStart(8)}`
  );
}

/**
 * One table's line: what was found, what moved, and — the point of it — whether
 * the row count actually moved by the amount claimed.
 *
 * `found/imported/skipped/damaged` are what the import BELIEVES it did, counted
 * by the same loops that did the writing. `rowsBefore → rowsAfter` are two
 * COUNT(*) queries. MISMATCH means those two stories disagree, which is the one
 * thing a migration report must never state quietly.
 */
function tallyLine(
  label: string,
  tally: MigrationTally,
  before: number,
  after: number
): string {
  const expected = before + tally.imported;
  const parity =
    expected === after
      ? `   ${before} → ${after}`
      : `   ${before} → ${after}  MISMATCH (expected ${expected})`;
  return (
    tallyCells(
      label,
      String(tally.found),
      String(tally.imported),
      String(tally.skipped),
      String(tally.damaged)
    ) + parity
  );
}

/** The human-readable report, printed by the daemon at boot and by the CLI. */
export function formatMigrationReport(report: MigrationReport): string {
  const lines: string[] = [];
  lines.push(
    report.dryRun
      ? `Dry run — nothing was written. ${report.rootDir}`
      : `Imported into the dispatch database: ${report.rootDir}`
  );
  lines.push('');
  lines.push(
    tallyCells('table', 'found', 'imported', 'present', 'damaged') + '   rows'
  );
  lines.push(
    tallyLine(
      'tasks',
      report.tasks,
      report.rowsBefore.tasks,
      report.rowsAfter.tasks
    )
  );
  lines.push(
    tallyLine(
      'epics',
      report.epics,
      report.rowsBefore.epics,
      report.rowsAfter.epics
    )
  );
  lines.push(
    tallyLine(
      'findings',
      report.findings,
      report.rowsBefore.findings,
      report.rowsAfter.findings
    )
  );
  lines.push(
    tallyLine(
      'ledger',
      report.ledger,
      report.rowsBefore.ledger,
      report.rowsAfter.ledger
    )
  );

  if (report.problems.length > 0) {
    lines.push('');
    lines.push(`  could not be imported (${report.problems.length}):`);
    for (const problem of report.problems) {
      lines.push(`    ${problem.source} — ${problem.detail}`);
    }
  }

  lines.push('');
  lines.push('  left as files, not imported:');
  for (const retained of report.retained) {
    const count = retained.found > 0 ? `${retained.found} record(s)` : '—';
    lines.push(
      `    ${retained.source.padEnd(34)} ${count.padEnd(12)} ${retained.reason}`
    );
  }

  lines.push('');
  lines.push(
    `  The originals under ${DISPATCH_DIR}/ are still exactly where they were: nothing was deleted, moved, or rewritten.`
  );
  return lines.join('\n');
}
