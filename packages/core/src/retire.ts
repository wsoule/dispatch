import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type { GitReader } from './actorContext.js';
import type { DispatchConfig } from './configTypes.js';
import { scanFindingsJsonl, scanLedgerJsonl } from './jsonlRecords.js';
import { hasLegacyState, retainedSources } from './migrate.js';
import type { RetainedSource } from './migrate.js';
import { readProjectBackend } from './storage.js';
import { DISPATCH_DIR, TaskStore } from './store.js';

// The last step of the move to the daemon's database: deleting the markdown
// and JSONL the import copied out, so a project's `.dispatch/` is left holding
// only the config a human would actually want to commit.
//
// WHY THIS IS A SEPARATE, EXPLICIT STEP.
//
// `importLegacyProject` is non-destructive on purpose — it can be re-run, and
// it can be rehearsed, precisely because it never consumes its source. That
// leaves every migrated project carrying a full second copy of its own board,
// still tracked by git, with nothing to remove it. This module is that
// removal, and it is deliberately not wired into daemon boot: deleting a
// project's task files is a git-visible act whose failure mode is silent and
// total, so a person runs it and a person commits it.
//
// THE SAFETY RULE, AND WHY IT POINTS AT THE RECEIPT LOG.
//
// Nothing is deleted unless the receipt log already contains it. The check
// runs SOURCE -> LOG, never DATABASE -> LOG: the question worth answering is
// "is everything I am about to delete recorded somewhere else?", and only the
// source side can answer that. Checking the database instead would miss
// exactly the records the import could not take — a task file with damaged
// frontmatter, a findings line that lost its id — which are the records most
// likely to be lost and least likely to be noticed.
//
// A source that fails the check is kept, with the reason, rather than failing
// the whole run. Retiring the two clean sources and reporting the third is
// more useful than an all-or-nothing refusal, and re-running after the export
// catches up finishes the job.

/** Where the receipt log keeps each kind of record, relative to the log root. */
const LOG_TASKS_DIR = `${DISPATCH_DIR}/tasks`;
const LOG_FINDINGS_FILE = `${DISPATCH_DIR}/findings.jsonl`;
const LOG_LEDGER_FILE = `${DISPATCH_DIR}/ledger.jsonl`;

/** How many ids an "not in the log yet" message names before it gives up. */
const NAMED_IDS = 5;

export interface RetireOptions {
  /** The receipt log to check against — see `receiptLogDir`. */
  receiptsDir: string;
  /** Report what would be removed without deleting anything. */
  dryRun?: boolean;
  /**
   * Reads git, for the shared-repo check below. Omitted skips that check —
   * which is what the tests do, and what a caller with no git available gets.
   */
  git?: GitReader;
  /** Proceed even though this repo has a remote. See the check below. */
  forceSolo?: boolean;
}

/** One legacy source and what happened to it. */
export interface RetiredSource {
  /** Project-relative, e.g. `.dispatch/tasks`. */
  source: string;
  /** Records it holds today. */
  records: number;
  removed: boolean;
  /** Why it was kept, when it was; null when it was removed. */
  blocked: string | null;
}

export interface RetireReport {
  rootDir: string;
  receiptsDir: string;
  dryRun: boolean;
  /** One entry per legacy source that is still present on disk. */
  sources: RetiredSource[];
  /**
   * The file-backed sources this never touches, carried through from the
   * import's own report. fix-loop state, notes and inboxes have no table in
   * the schema, so they are not in the database and therefore not in the
   * receipt log — deleting them would lose them outright.
   */
  kept: RetainedSource[];
}

// `DISPATCH_HOME` before `homedir()`. This is the seventh copy of a scheme
// that already has six (see the roll-call in
// packages/server/src/orchestrator/paths.ts) and it exists because the CLI
// cannot reach the sixth: `@dispatch/server` exports only `./embed` and
// `./testing`, so `resolveReceiptsDir` and `receiptsDir` are not importable
// from `@dispatch/cli`. Fold this and the exporter's copy together when
// packages/server/src/receipts/exporter.ts is next touched.
function dispatchHome(): string {
  const home = process.env.DISPATCH_HOME;
  return home !== undefined && home !== '' ? home : homedir();
}

// Must stay byte-identical to `rootHash` in the orchestrator's paths.ts, or
// this resolves a different directory than the exporter writes to.
function rootHash(rootDir: string): string {
  return createHash('sha256').update(rootDir).digest('hex').slice(0, 12);
}

/**
 * Where this project's receipt log lives: `receipts.dir` from config.yml if
 * set, otherwise the default under DISPATCH_HOME.
 *
 * A relative override resolves against the project root, not the caller's
 * working directory, because config.yml is a file a person edits by hand
 * inside their repo and `receipts.dir: ../audit` should mean what it looks
 * like it means there. Same rule as the exporter's `resolveReceiptsDir`.
 */
export function receiptLogDir(rootDir: string, config: DispatchConfig): string {
  const configured = config.receipts?.dir;
  if (configured !== undefined) {
    return isAbsolute(configured) ? configured : resolve(rootDir, configured);
  }
  // `resolve` because the daemon hashes an already-resolved root (startServer
  // takes `resolve(--root ?? cwd)`), and a trailing slash or a relative cwd
  // would otherwise hash to a directory the exporter never wrote to.
  return join(
    dispatchHome(),
    '.dispatch',
    'projects',
    rootHash(resolve(rootDir)),
    'receipts'
  );
}

// The compaction key the JSONL stores use: id AND createdAt, never id alone.
// Two lines sharing an id but differing in createdAt are two distinct
// surviving records (see jsonlRecords.ts), so keying on id would call a
// record covered when only its namesake is.
function recordKey(record: { id: string; createdAt: string }): string {
  return `${record.id}\n${record.createdAt}`;
}

// Reads a receipt-log JSONL into the same keys the source side produces. A
// missing file is an empty set, not an error: it means the log covers nothing,
// which the caller reports as "not in the log yet" rather than as a crash.
function loggedKeys(
  file: string,
  scan: (text: string) => { records: { id: string; createdAt: string }[] }
): Set<string> {
  if (!existsSync(file)) return new Set();
  return new Set(scan(readFileSync(file, 'utf8')).records.map(recordKey));
}

// Formats "3 of 7 are not in the receipt log yet: a, b, c" without printing an
// unbounded list of ids into a terminal.
function missingDetail(missing: string[], total: number): string {
  const named = missing.slice(0, NAMED_IDS).join(', ');
  const rest =
    missing.length > NAMED_IDS
      ? `, and ${missing.length - NAMED_IDS} more`
      : '';
  return `${missing.length} of ${total} are not in the receipt log yet (${named}${rest}) — let the daemon finish exporting, then run this again`;
}

// Checks `.dispatch/tasks` against the log's copy of it.
//
// Two things block beyond a plain coverage miss. A file that will not parse
// has no id to look up, so it cannot be proven safe. And a non-`.md` entry in
// the directory is something no task store ever wrote and no exporter ever
// copied — removing the directory would take it with it, so its presence
// stops the removal instead.
function checkTasks(
  rootDir: string,
  receiptsDir: string
): RetiredSource | null {
  const source = new TaskStore(rootDir);
  if (!source.isInitialized()) return null;
  const stray = readdirSync(source.tasksDir).filter((f) => !f.endsWith('.md'));
  const { docs, errors } = source.listSafe();
  const entry: RetiredSource = {
    source: LOG_TASKS_DIR,
    records: docs.length + errors.length,
    removed: false,
    blocked: null,
  };
  if (stray.length > 0) {
    entry.blocked = `${stray.length} entr(y/ies) here are not task files (${stray.slice(0, NAMED_IDS).join(', ')}) and are not in the receipt log — move them out first`;
    return entry;
  }
  if (errors.length > 0) {
    entry.blocked = `${errors.length} task file(s) will not parse (${errors[0]?.file}: ${errors[0]?.message}), so their ids cannot be checked against the receipt log`;
    return entry;
  }
  const logged = new Set(
    new TaskStore(receiptsDir).listSafe().docs.map((d) => d.meta.id)
  );
  const missing = docs
    .map((d) => d.meta.id)
    .filter((id) => !logged.has(id))
    .sort();
  if (missing.length > 0) {
    entry.blocked = missingDetail(missing, docs.length);
  }
  return entry;
}

// Checks one JSONL sidecar against the log's copy of it. Unparseable and
// invalid lines block for the same reason a damaged task file does: a line
// that does not read back as a record has no key, so nothing can vouch for it.
function checkJsonl(
  rootDir: string,
  receiptsDir: string,
  relative: string,
  scan: (text: string) => {
    records: { id: string; createdAt: string }[];
    unparseableLines: string[];
    invalidLines: string[];
  }
): RetiredSource | null {
  const file = join(rootDir, relative);
  if (!existsSync(file)) return null;
  const parsed = scan(readFileSync(file, 'utf8'));
  const entry: RetiredSource = {
    source: relative,
    records: parsed.records.length,
    removed: false,
    blocked: null,
  };
  const damaged = parsed.unparseableLines.length + parsed.invalidLines.length;
  if (damaged > 0) {
    entry.blocked = `${damaged} line(s) do not read back as records, so they have no id to check against the receipt log`;
    return entry;
  }
  const logged = loggedKeys(join(receiptsDir, relative), scan);
  const missing = parsed.records
    .filter((record) => !logged.has(recordKey(record)))
    .map((record) => record.id)
    .sort();
  if (missing.length > 0) {
    entry.blocked = missingDetail(missing, parsed.records.length);
  }
  return entry;
}

// Whether this repo has any git remote configured. A failed or unavailable
// git read answers "no remote": the check exists to stop a shared-repo
// mistake, and a broken git invocation is not evidence of sharing.
function hasGitRemote(git: GitReader): boolean {
  const remotes = git(['remote']);
  return remotes !== null && remotes.trim() !== '';
}

/**
 * Deletes the legacy sources the receipt log already covers.
 *
 * Refuses outright — rather than reporting per source — in the two cases where
 * no source could possibly be safe to remove: a project that never moved to
 * the database (its files ARE the board), and a missing receipt log (nothing
 * to have been copied into).
 *
 * A project with no legacy state left is not an error. It is what a second run
 * looks like, and it reports an empty list.
 */
export function retireLegacySources(
  rootDir: string,
  options: RetireOptions
): RetireReport {
  const { receiptsDir, dryRun = false, git, forceSolo = false } = options;
  if (readProjectBackend(rootDir) !== 'sqlite') {
    throw new Error(
      `${rootDir} still keeps its tasks as files — these ARE its board, so removing them would delete it. Move the project to the database first: dispatch migrate`
    );
  }
  // THE SHARED-REPO CHECK. The receipt log this verifies against lives under
  // your home directory: it is per-machine, and it is not what teammates pull.
  // So on a repo with a remote, "safe to delete" is only true for YOU. Everyone
  // else pulls the commit that removes the board and gets nothing back — their
  // clone has no database, no receipt log, and now no markdown either, and the
  // report below would have told you to commit exactly that.
  //
  // Refusing by default rather than warning, because the damage is other
  // people's and is discovered on their next pull, long after the run that
  // caused it. `dryRun` is exempt: rehearsing tells you what you would be
  // asking for, and refusing to even describe it is unhelpful.
  if (!dryRun && !forceSolo && git !== undefined && hasGitRemote(git)) {
    throw new Error(
      `${rootDir} has a git remote, so its .dispatch board is shared. The receipt log backing this deletion is per-machine (${receiptsDir}) and is NOT pulled by anyone else — retiring here and committing it would leave every teammate with an empty board and no copy to restore from. If this repo is really only yours, re-run with --force-solo.`
    );
  }
  const report: RetireReport = {
    rootDir,
    receiptsDir,
    dryRun,
    sources: [],
    kept: retainedSources(rootDir),
  };
  if (!hasLegacyState(rootDir)) return report;
  if (!existsSync(join(receiptsDir, DISPATCH_DIR))) {
    throw new Error(
      `no receipt log at ${receiptsDir}, so there is no second copy of these records to fall back on. Start the daemon once to export one (receipts must be enabled in .dispatch/config.yml), then run this again.`
    );
  }
  const sources = [
    checkTasks(rootDir, receiptsDir),
    checkJsonl(rootDir, receiptsDir, LOG_FINDINGS_FILE, scanFindingsJsonl),
    checkJsonl(rootDir, receiptsDir, LOG_LEDGER_FILE, scanLedgerJsonl),
  ];
  for (const entry of sources) {
    if (entry === null) continue;
    report.sources.push(entry);
    if (entry.blocked !== null || dryRun) continue;
    rmSync(join(rootDir, entry.source), { recursive: true, force: true });
    entry.removed = true;
  }
  return report;
}

/** The report as printed text, for `dispatch migrate --retire`. */
export function formatRetireReport(report: RetireReport): string {
  const lines: string[] = [];
  const heading = report.dryRun ? 'Would retire' : 'Retired';
  lines.push(`${heading} legacy state in ${report.rootDir}`);
  lines.push(`  receipt log: ${report.receiptsDir}`);
  lines.push('');
  if (report.sources.length === 0) {
    lines.push('  Nothing to retire — no markdown or JSONL board is left.');
    return lines.join('\n');
  }
  for (const entry of report.sources) {
    const verb = entry.blocked !== null ? 'kept' : report.dryRun ? '→' : '✓';
    lines.push(
      `  ${verb} ${entry.source.padEnd(28)} ${String(entry.records).padStart(5)} record(s)`
    );
    if (entry.blocked !== null) lines.push(`      ${entry.blocked}`);
  }
  lines.push('');
  lines.push('  Left in place (no table in the schema, so not in the log):');
  for (const kept of report.kept) {
    lines.push(`    ${kept.source.padEnd(34)} ${kept.reason}`);
  }
  const removed = report.sources.filter((s) => s.blocked === null);
  if (removed.length > 0 && !report.dryRun) {
    lines.push('');
    lines.push(
      '  Commit the deletion when you are happy with it. What stays committed'
    );
    lines.push(
      `  in ${DISPATCH_DIR}/ is the config — config.yml and team.yml; the database`
    );
    lines.push('  and the storage marker are per-machine and are gitignored.');
    lines.push(`    git add -A ${DISPATCH_DIR} && git commit`);
  }
  return lines.join('\n');
}
