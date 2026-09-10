import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { CommandEvidence, MutationEvidence } from './evidence.js';
import { isTaskId } from './ids.js';
import { importLegacyProject } from './migrate.js';
import type { MigrationReport } from './migrate.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { DISPATCH_DIR } from './store.js';
import type { ListSafeError } from './store.js';
import type { ProjectStores, SqliteRecordStores } from './storeBackend.js';

// The git-versioned audit trail: everything the daemon's database holds,
// written out as ordinary files so a human — or a future maintainer with no
// dispatch binary at all — can read the project's history out of git.
//
// THE FORMAT IS THE LEGACY FILE LAYOUT, ON PURPOSE.
//
// A receipt log is laid out exactly as a file-backed dispatch project:
// `.dispatch/tasks/<id>-<slug>.md` beside `.dispatch/findings.jsonl` and
// `.dispatch/ledger.jsonl`. That is not nostalgia, it is what makes the
// round-trip claim testable rather than aspirational. Restoring is
// `importLegacyProject()` pointed at the log (see restoreReceipts below), so
// there is exactly one deserializer for this format and it is the same one the
// one-time migration already uses in production. A bespoke reader written here
// would be a second copy of that logic, free to drift, and the drift would be
// silent — a restore that quietly serves a different board than the export
// captured.
//
// It also means the cheapest possible disaster recovery needs no code at all:
// copy `receipts/.dispatch` into a repo and it IS the board again.
//
// WHAT IS NOT HERE. Evidence and mutations have no legacy file form — on the
// file backend they live in run transcripts under `~/.dispatch/runs/`, outside
// the project entirely — so `.dispatch/evidence/<runId>.jsonl` is a shape this
// module defines and reads back itself. `.dispatch/config.yml` is deliberately
// NOT exported: it stays a committable file in the project's own repo, already
// under git there, and duplicating it would create a second copy with no rule
// about which one wins.

/** Where the receipt log keeps each kind of record, relative to the log root. */
const TASKS_DIR = `${DISPATCH_DIR}/tasks`;
const FINDINGS_FILE = `${DISPATCH_DIR}/findings.jsonl`;
const LEDGER_FILE = `${DISPATCH_DIR}/ledger.jsonl`;
const EVIDENCE_DIR = `${DISPATCH_DIR}/evidence`;
const README_FILE = 'README.md';

/** How many records of each kind the log now holds. */
export interface ReceiptsTally {
  tasks: number;
  findings: number;
  ledger: number;
  runs: number;
  commands: number;
  mutations: number;
}

/** One record the export could not write, or the restore could not read. */
export interface ReceiptsProblem {
  source: string;
  detail: string;
}

export interface ReceiptsExport {
  dir: string;
  tally: ReceiptsTally;
  /**
   * Log-relative paths whose CONTENT changed this pass — not every path
   * written. An export that changed nothing returns an empty list, which is
   * what lets the daemon skip a commit without asking git anything.
   */
  changed: string[];
  /**
   * Log-relative paths this pass deleted, because the record behind them is no
   * longer in the database. Deletions are part of the audit trail: git records
   * that a task stopped existing, and when.
   */
  removed: string[];
  problems: ReceiptsProblem[];
}

export interface ReceiptsRestore {
  /** Tasks, findings and ledger entries, imported by the shared migration. */
  migration: MigrationReport;
  runs: number;
  commands: number;
  mutations: number;
  /** Runs left alone because the target already held evidence for them. */
  skippedRuns: number;
  problems: ReceiptsProblem[];
}

/**
 * The stores an export reads, narrowed to the backend that has them.
 *
 * The file backend is refused rather than made to work: its state is already
 * files under git in the user's own repo, which is precisely what the board
 * syncer commits. Exporting it again would put the same records in two git
 * histories with no rule about which is authoritative.
 */
function requireDatabase(stores: ProjectStores): {
  tasks: SqliteTaskStore;
  records: SqliteRecordStores;
} {
  if (stores.records === null || !(stores.tasks instanceof SqliteTaskStore)) {
    throw new Error(
      `cannot export receipts from the files backend: ${stores.tasks.rootDir} keeps its state as files under git already`
    );
  }
  return { tasks: stores.tasks, records: stores.records };
}

/**
 * Writes `content` only when it differs from what is already there, and
 * reports whether it actually changed.
 *
 * The comparison is the point, not an optimization. The daemon commits this
 * log on a debounce, and an export that rewrote every file each pass would
 * leave git unable to tell a real edit from a re-run — `changed` is what the
 * exporter uses to decide there is nothing to commit at all.
 */
function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}

/**
 * The JSONL for a record set, carrying forward the lines of any rows that could
 * not be read this pass.
 *
 * These files are rewritten whole from what `listSafe` returns, so a row the
 * database can no longer parse simply is not in `records` — and rewriting
 * without it DELETES that finding or decision from the log and commits the
 * deletion. The row is still in the database; only this build cannot read it.
 * Losing the last readable copy of a record because of a column the schema
 * grew past is exactly what an audit trail must not do.
 *
 * Rows that genuinely left the database are still dropped: only ids `listSafe`
 * actively reported as damaged are carried over.
 */
function jsonlKeepingDamaged(
  path: string,
  records: { id: string }[],
  damaged: ListSafeError[]
): string {
  if (damaged.length === 0) return toJsonl(records);
  const previous = readJsonlById(path);
  const written = new Set(records.map((record) => record.id));
  const carried: string[] = [];
  for (const error of damaged) {
    // `error.file` is the row id. Skipped when the current set already carries
    // that id (nothing to rescue) or the log has never held it.
    if (written.has(error.file)) continue;
    const line = previous.get(error.file);
    if (line !== undefined) carried.push(line);
  }
  const lines = [
    ...records.map((record) => JSON.stringify(record)),
    ...carried,
  ];
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

// The lines of an existing JSONL file, keyed by the id each one carries. Used
// only to rescue damaged rows, so an unparseable line is skipped rather than
// reported: it belongs to no id anyone can ask about.
function readJsonlById(path: string): Map<string, string> {
  const byId = new Map<string, string>();
  if (!existsSync(path)) return byId;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as { id?: unknown };
      if (typeof parsed.id === 'string') byId.set(parsed.id, line);
    } catch {
      // Not a record this can rescue.
    }
  }
  return byId;
}

/** One JSON object per line, with a trailing newline, as the JSONL scanners read it. */
function toJsonl(records: unknown[]): string {
  if (records.length === 0) return '';
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

// A run's evidence as one chronological file: the commands it ran, then the
// guards it mutation-tested. Both shapes carry `type` because they share a
// file — the restore reads it back to tell them apart, and a human reading the
// log gets the discriminator spelled out rather than inferred from which keys
// happen to be present.
function evidenceJsonl(
  commands: CommandEvidence[],
  mutations: MutationEvidence[]
): string {
  return toJsonl([
    ...commands.map((command) => ({ type: 'command', ...command })),
    ...mutations.map((mutation) => ({ type: 'mutation', ...mutation })),
  ]);
}

const README = `# Dispatch receipts

This is the audit trail for a Dispatch project: every task, finding, ledger
entry and piece of run evidence the daemon's database holds, written out as
files and committed on every change. The git history here IS the task history
— \`git log\` shows when each task changed, and \`git show\` shows what it said
before.

Nothing here is generated from anything else. If the database is lost, this
directory is enough to rebuild it.

## Layout

    .dispatch/tasks/<id>-<slug>.md   one file per task and epic
    .dispatch/findings.jsonl         review findings, one JSON object per line
    .dispatch/ledger.jsonl           decisions and hazards
    .dispatch/evidence/<runId>.jsonl commands run and guards mutation-tested

That is deliberately the same layout a file-backed Dispatch project uses, so
restoring needs no special tooling.

## Restoring

Copy the \`.dispatch\` directory into a repository and it is a working board:

    cp -r .dispatch /path/to/your/repo/

Point Dispatch at that repository and it will import what it finds. Evidence
under \`.dispatch/evidence/\` is read by the restore path specifically and has
no file-backed equivalent, so it survives that route only through Dispatch's
own restore rather than through the copy above.

## What is NOT here

\`.dispatch/config.yml\` and \`.dispatch/team.yml\` are committable project
files and stay in the project's own repository, under its own git history.
They are not duplicated here.

Fix-loop state, notes and inboxes are still file-backed in the project
repository and have no table in the database, so they do not reach this log.
`;

/**
 * Writes the whole of a project's database out to `dir` as a receipt log, and
 * reports what changed.
 *
 * A full materialization every pass, not an append: the log is always exactly
 * what the database holds right now, and git supplies the history. That is
 * what makes the export idempotent — running it twice against an unchanged
 * database changes nothing and commits nothing — and it is also the only way
 * deletions and edits show up at all, since an append-only log can only ever
 * grow.
 */
export function materializeReceipts(
  stores: ProjectStores,
  dir: string
): ReceiptsExport {
  const { tasks, records } = requireDatabase(stores);
  const problems: ReceiptsProblem[] = [];
  const changed: string[] = [];
  const removed: string[] = [];

  // Tasks, one markdown file each, through the same serializer the file
  // backend uses. A row that will not serialize costs itself and is named,
  // rather than taking the whole export down: an export that refuses to run
  // because of one damaged row is an audit trail that stops updating exactly
  // when something has gone wrong.
  const expectedTaskFiles = new Set<string>();
  const unexportedTaskIds = new Set<string>();
  const board = tasks.listSafe();
  for (const error of board.errors) {
    // `error.file` is the row id on this backend. The row is still IN the
    // database — only unreadable — so its previously exported file has to be
    // kept for the same reason a toMarkdown failure below keeps one: pruning
    // it would turn one damaged column into the deletion of the only copy of
    // that task's history, and commit the deletion.
    unexportedTaskIds.add(error.file);
    problems.push({
      source: TASKS_DIR,
      detail: `${error.file}: ${error.message}`,
    });
  }
  let taskCount = 0;
  for (const doc of board.docs) {
    try {
      const file = tasks.toMarkdown(doc.meta.id);
      if (file === null) continue;
      expectedTaskFiles.add(file.filename);
      taskCount += 1;
      if (writeIfChanged(join(dir, TASKS_DIR, file.filename), file.content)) {
        changed.push(`${TASKS_DIR}/${file.filename}`);
      }
    } catch (err) {
      unexportedTaskIds.add(doc.meta.id);
      problems.push({
        source: TASKS_DIR,
        detail: `${doc.meta.id}: ${(err as Error).message}`,
      });
    }
  }
  removed.push(
    ...pruneTaskFiles(
      join(dir, TASKS_DIR),
      expectedTaskFiles,
      unexportedTaskIds
    )
  );

  const findings = records.findings.listSafe({});
  for (const error of findings.errors) {
    problems.push({
      source: FINDINGS_FILE,
      detail: `${error.file}: ${error.message}`,
    });
  }
  const findingsPath = join(dir, FINDINGS_FILE);
  if (
    writeIfChanged(
      findingsPath,
      jsonlKeepingDamaged(findingsPath, findings.records, findings.errors)
    )
  ) {
    changed.push(FINDINGS_FILE);
  }

  const ledger = records.ledger.listSafe({});
  for (const error of ledger.errors) {
    problems.push({
      source: LEDGER_FILE,
      detail: `${error.file}: ${error.message}`,
    });
  }
  const ledgerPath = join(dir, LEDGER_FILE);
  if (
    writeIfChanged(
      ledgerPath,
      jsonlKeepingDamaged(ledgerPath, ledger.records, ledger.errors)
    )
  ) {
    changed.push(LEDGER_FILE);
  }

  const runIds = records.evidence.runIds();
  const expectedEvidenceFiles = new Set<string>();
  let commands = 0;
  let mutations = 0;
  for (const runId of runIds) {
    // `run_id` arrives from the orchestrator and is only ever an opaque key in
    // this database, so it is checked before it becomes a filename — the same
    // reason toMarkdown re-checks the ids it puts in one. Checked BEFORE the
    // records are counted: the tally states what the log holds, so counting a
    // rejected run's evidence would have it claim records nobody can read.
    if (!isRunFileName(runId)) {
      problems.push({
        source: EVIDENCE_DIR,
        detail: `${runId}: not a usable run id, so its evidence was not exported`,
      });
      continue;
    }
    const runCommands = records.evidence.commandsFor(runId);
    const runMutations = records.evidence.mutationsFor(runId);
    commands += runCommands.length;
    mutations += runMutations.length;
    const filename = `${runId}.jsonl`;
    expectedEvidenceFiles.add(filename);
    if (
      writeIfChanged(
        join(dir, EVIDENCE_DIR, filename),
        evidenceJsonl(runCommands, runMutations)
      )
    ) {
      changed.push(`${EVIDENCE_DIR}/${filename}`);
    }
  }
  removed.push(
    ...pruneFiles(join(dir, EVIDENCE_DIR), '.jsonl', EVIDENCE_DIR, (name) =>
      expectedEvidenceFiles.has(name)
    )
  );

  if (writeIfChanged(join(dir, README_FILE), README)) changed.push(README_FILE);

  return {
    dir,
    tally: {
      tasks: taskCount,
      findings: findings.records.length,
      ledger: ledger.records.length,
      runs: expectedEvidenceFiles.size,
      commands,
      mutations,
    },
    changed,
    removed,
    problems,
  };
}

/**
 * Deletes exported task files whose task is no longer in the database.
 *
 * A task the database dropped has to leave the working tree so the commit
 * records the deletion — that IS the audit trail for a removed task. But a
 * task that is still in the database and merely failed to serialize this pass
 * must keep its file: deleting it would turn one damaged row into the silent
 * loss of the last good receipt that row ever produced. Those are told apart
 * by the id the filename starts with, which is why `toMarkdown` guarantees the
 * `<id>-<slug>.md` shape.
 */
function pruneTaskFiles(
  tasksDir: string,
  expected: Set<string>,
  keepIds: Set<string>
): string[] {
  return pruneFiles(tasksDir, '.md', TASKS_DIR, (name) => {
    if (expected.has(name)) return true;
    const id = name.slice(0, 8);
    return isTaskId(id) && keepIds.has(id);
  });
}

// Removes every file in `dir` with the given extension that `keep` rejects,
// returning the log-relative paths deleted. A directory that does not exist
// yet has nothing to prune.
function pruneFiles(
  dir: string,
  extension: string,
  relativeDir: string,
  keep: (filename: string) => boolean
): string[] {
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(extension) || keep(name)) continue;
    rmSync(join(dir, name), { force: true });
    removed.push(`${relativeDir}/${name}`);
  }
  return removed;
}

// Run ids reach this database from the orchestrator without ever being
// validated here, so anything that would escape the evidence directory — a
// separator, a parent reference, a leading dot — is refused rather than
// normalized. Being conservative costs an unexported evidence file, which the
// export names; being permissive costs a write outside the log.
function isRunFileName(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) && !runId.includes('..');
}

// Every column the evidence tables declare NOT NULL, checked before the insert
// rather than after. A hand-edited line missing one does not degrade the row,
// it fails to insert at all — and since the restore is what someone reaches for
// when the database is already gone, one bad line must cost itself rather than
// abort the rebuild.
function readCommand(record: Record<string, unknown>): CommandEvidence | null {
  if (
    typeof record.command !== 'string' ||
    typeof record.exitCode !== 'number' ||
    typeof record.durationMs !== 'number' ||
    typeof record.summary !== 'string' ||
    typeof record.at !== 'string'
  ) {
    return null;
  }
  return {
    command: record.command,
    exitCode: record.exitCode,
    durationMs: record.durationMs,
    summary: record.summary,
    at: record.at,
  };
}

function readMutation(
  record: Record<string, unknown>
): MutationEvidence | null {
  if (
    typeof record.guard !== 'string' ||
    typeof record.file !== 'string' ||
    typeof record.testsFailed !== 'number' ||
    typeof record.at !== 'string'
  ) {
    return null;
  }
  return {
    guard: record.guard,
    file: record.file,
    testsFailed: record.testsFailed,
    at: record.at,
  };
}

/**
 * Imports one run's evidence file, all of it or none of it.
 *
 * The transaction is what makes restoreReceipts' per-run idempotency guard
 * honest. Without it, a rebuild interrupted midway through a run leaves that
 * run holding some of its records; the guard then sees evidence present, calls
 * it "already restored", and skips it on every future pass — so the truncation
 * is permanent and is reported as a skip rather than as data loss.
 *
 * Returns null when the run was rolled back, having recorded why.
 */
function restoreRunEvidence(
  records: SqliteRecordStores,
  runId: string,
  text: string,
  source: string,
  problems: ReceiptsProblem[]
): { commands: number; mutations: number } | null {
  const found: ReceiptsProblem[] = [];
  let commands = 0;
  let mutations = 0;
  records.db.exec('BEGIN');
  try {
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        found.push({ source, detail: `not valid JSON: ${line.slice(0, 120)}` });
        continue;
      }
      const record = parsed as Record<string, unknown>;
      if (record.type === 'command') {
        const command = readCommand(record);
        if (command === null) {
          found.push({
            source,
            detail: `not a command: ${line.slice(0, 120)}`,
          });
          continue;
        }
        records.evidence.addCommand(runId, command);
        commands += 1;
      } else if (record.type === 'mutation') {
        const mutation = readMutation(record);
        if (mutation === null) {
          found.push({
            source,
            detail: `not a mutation: ${line.slice(0, 120)}`,
          });
          continue;
        }
        records.evidence.addMutation(runId, mutation);
        mutations += 1;
      } else {
        found.push({
          source,
          detail: `unknown record type: ${line.slice(0, 120)}`,
        });
      }
    }
    records.db.exec('COMMIT');
  } catch (err) {
    records.db.exec('ROLLBACK');
    problems.push({
      source,
      detail: `left unrestored, its records rolled back: ${(err as Error).message}`,
    });
    return null;
  }
  problems.push(...found);
  return { commands, mutations };
}

/**
 * Rebuilds a database from a receipt log: the inverse of materializeReceipts,
 * and the executable form of the promise that this log is enough on its own.
 *
 * Tasks, findings and ledger entries go through `importLegacyProject` — the
 * same import the one-time migration runs — because the log is laid out as a
 * file-backed project for exactly this reason. Only evidence needs code here,
 * since it has no file-backed form to reuse.
 */
export function restoreReceipts(
  dir: string,
  stores: ProjectStores
): ReceiptsRestore {
  const { records } = requireDatabase(stores);
  const migration = importLegacyProject(stores, { sourceDir: dir });
  const problems: ReceiptsProblem[] = [];
  const evidenceDir = join(dir, EVIDENCE_DIR);
  let runs = 0;
  let commands = 0;
  let mutations = 0;
  let skippedRuns = 0;
  if (existsSync(evidenceDir)) {
    for (const name of readdirSync(evidenceDir).sort()) {
      if (!name.endsWith('.jsonl')) continue;
      const runId = name.slice(0, -'.jsonl'.length);
      const source = `${EVIDENCE_DIR}/${name}`;
      // Idempotency is a whole-run check rather than a per-record one, because
      // `seq` is assigned by the INSERT and never carried in the file. Replaying
      // a run whose evidence is already present would append a second copy under
      // fresh sequence numbers instead of colliding, so the guard has to be
      // "does this run have any evidence at all" and it has to come first.
      //
      // That guard is only safe because the import below is atomic per run: a
      // half-imported run would answer "yes, present" forever, permanently
      // truncating its evidence and reporting the loss as an ordinary skip.
      if (
        records.evidence.commandsFor(runId).length > 0 ||
        records.evidence.mutationsFor(runId).length > 0
      ) {
        skippedRuns += 1;
        continue;
      }
      let text: string;
      try {
        text = readFileSync(join(evidenceDir, name), 'utf8');
      } catch (err) {
        // A file that cannot be read costs itself. This is the path someone
        // reaches for when the database is already gone, so one unreadable run
        // must not abandon the rest of the rebuild.
        problems.push({
          source,
          detail: `could not be read: ${(err as Error).message}`,
        });
        continue;
      }
      const imported = restoreRunEvidence(
        records,
        runId,
        text,
        source,
        problems
      );
      if (imported === null) continue;
      runs += 1;
      commands += imported.commands;
      mutations += imported.mutations;
    }
  }
  return { migration, runs, commands, mutations, skippedRuns, problems };
}
