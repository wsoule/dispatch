import {
  dispatchDbPath,
  formatMigrationReport,
  formatRetireReport,
  hasLegacyState,
  importLegacyProject,
  initProjectStores,
  loadConfig,
  openProjectStores,
  readProjectBackend,
  receiptLogDir,
  retireLegacySources,
  totalImported,
  writeProjectBackend,
} from '@dispatch/core';
import type { MigrationReport, ProjectStores } from '@dispatch/core';
import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { type CliContext, CliError } from '../context.js';
import { findRunningDaemon } from './daemon.js';

// `dispatch migrate` — the one-time move of a project's markdown-and-JSONL
// state into the daemon's database. The import itself lives in @dispatch/core
// (migrate.ts); this file is the terminal around it: choosing what to open,
// refusing to run when it would be unsafe, and recording the project's new
// backend once the import has actually committed.

// Node-based GitReader, mirroring the one in commands/task.ts. Used only for
// the shared-repo check in `--retire`; a git that will not run reads as "no
// remote", which retireLegacySources treats as not-shared.
function makeGitReader(cwd: string) {
  return (args: string[]): string | null => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
}

const DAEMON_RUNNING =
  'dispatchd is running for this project. It is the single writer of the ' +
  'store and holds its own in-memory cache of the board, so a migration ' +
  'landing underneath it would be invisible until it restarts. Stop it first: ' +
  'dispatch daemon stop';

export function registerMigrateCommand(
  program: Command,
  ctx: CliContext
): void {
  program
    .command('migrate')
    .description(
      "import this project's .dispatch markdown and JSONL into the daemon database"
    )
    .option(
      '-n, --dry-run',
      'report what would move without writing anything',
      false
    )
    .option(
      '--retire',
      'delete the markdown and JSONL a previous import already copied out, once the receipt log covers them',
      false
    )
    .option(
      '--force-solo',
      'allow --retire in a repo with a git remote (the receipt log is per-machine, so teammates get an empty board)',
      false
    )
    .action(
      async (opts: {
        dryRun: boolean;
        retire: boolean;
        forceSolo: boolean;
      }) => {
        ctx.log(
          opts.retire
            ? await runRetire(ctx, opts.dryRun, opts.forceSolo)
            : await runMigrate(ctx, opts.dryRun)
        );
      }
    );
}

/**
 * Runs (or rehearses) the import and returns the report as printed text.
 *
 * Split out of the action so the decision-making — which database to open,
 * when to refuse, whether to record the backend — is testable without a
 * commander instance around it.
 */
export async function runMigrate(
  ctx: CliContext,
  dryRun: boolean
): Promise<string> {
  const rootDir = ctx.cwd;
  if ((await findRunningDaemon(rootDir)) !== null) {
    throw new CliError(DAEMON_RUNNING);
  }

  const alreadyMigrated = readProjectBackend(rootDir) === 'sqlite';
  if (!hasLegacyState(rootDir)) {
    return alreadyMigrated
      ? `Nothing to import: ${rootDir} already keeps its tasks in the daemon database.`
      : `Nothing to import: ${rootDir} has no .dispatch tasks, findings, or ledger to move.`;
  }

  const stores = openImportTarget(rootDir, dryRun);
  let report: MigrationReport;
  try {
    report = importLegacyProject(stores, { dryRun });
  } finally {
    stores.close();
  }

  const lines = [formatMigrationReport(report)];
  if (dryRun) {
    lines.push('');
    lines.push('Re-run without --dry-run to import.');
  } else if (!alreadyMigrated) {
    lines.push('');
    if (report.problems.length > 0) {
      // Deliberately NOT flipping the marker. Every process reads it to decide
      // where this project's board lives, so recording `sqlite` here would
      // declare the database authoritative while the records listed above
      // exist only in the markdown — and the CLI and MCP would then refuse to
      // read the files still holding them. Leaving the project on `files`
      // keeps the complete board reachable; the import already committed, so
      // fixing the named records and re-running picks up only the stragglers.
      lines.push(
        `NOT recorded as database-backed: ${report.problems.length} record(s) above could not be imported, ` +
          'and marking the database authoritative would strand them. ' +
          `${totalImported(report)} record(s) were copied and are safe to re-run over. ` +
          'Fix the records listed above and run dispatch migrate again.'
      );
    } else {
      // Written only after the import has committed. The marker is what every
      // other process — the next daemon boot, the CLI, the MCP tools — reads
      // to decide where this project's tasks live, so setting it before the
      // rows exist would point them at an empty database.
      writeProjectBackend(rootDir, 'sqlite');
      lines.push(
        `Recorded this project as database-backed. The originals are still in .dispatch/ — ${totalImported(report)} record(s) were copied, not moved. ` +
          'Once the daemon has exported a receipt log, remove them with: dispatch migrate --retire'
      );
    }
  }
  return lines.join('\n');
}

/**
 * Opens the database this run should import into.
 *
 * A dry run must not bring a `dispatch.db` (plus its -wal and -shm companions)
 * into a repo that never asked for one — writing three files is a strange way
 * to honour "nothing was written". So when the project has no database yet, a
 * rehearsal imports into an in-memory one instead: for a project that has
 * never migrated, an empty database is exactly what the real import would
 * start from, so the numbers are the same ones.
 *
 * Once a database DOES exist, both modes attach to it, because from then on
 * the interesting part of the report is what is already there — every record
 * counted as skipped rather than imported.
 */
function openImportTarget(rootDir: string, dryRun: boolean): ProjectStores {
  if (dryRun && !existsSync(dispatchDbPath(rootDir))) {
    // openProjectStores, NOT initProjectStores: the init path also scaffolds
    // `.dispatch/config.yml` when the project has none, and a dry run that
    // creates a config file has written something. Attaching to `:memory:`
    // still yields a real, empty database (attachDispatchDb short-circuits
    // its existence check for it), which is exactly the starting state a
    // first real import would see.
    return openProjectStores({
      rootDir,
      backend: 'sqlite',
      dbPath: ':memory:',
    });
  }
  return dryRun
    ? openProjectStores({ rootDir, backend: 'sqlite' })
    : initProjectStores({ rootDir, backend: 'sqlite' });
}

/**
 * The other half of `dispatch migrate`: deleting what the import copied out.
 *
 * Kept behind a flag on the same command rather than given its own, because
 * the two are one operation a person performs in two sittings — import, let
 * the daemon export a receipt log, then retire. A separate top-level verb
 * would read like an unrelated feature.
 *
 * The daemon check is the same one the import uses and matters more here: the
 * receipt exporter runs INSIDE dispatchd, so a running daemon is also the
 * thing actively writing the log this reads to decide what is safe to delete.
 * Checking a moving target is how a source gets cleared on the strength of a
 * half-written export.
 *
 */
export async function runRetire(
  ctx: CliContext,
  dryRun: boolean,
  forceSolo = false
): Promise<string> {
  const rootDir = ctx.cwd;
  if ((await findRunningDaemon(rootDir)) !== null) {
    throw new CliError(DAEMON_RUNNING);
  }
  try {
    return formatRetireReport(
      retireLegacySources(rootDir, {
        receiptsDir: receiptLogDir(rootDir, loadConfig(rootDir)),
        dryRun,
        git: makeGitReader(rootDir),
        forceSolo,
      })
    );
  } catch (err) {
    // retireLegacySources throws only for the two states where no source could
    // be safe to remove, and both messages already name the command to run
    // next — so they are surfaced verbatim rather than wrapped in a second
    // layer of explanation.
    throw new CliError((err as Error).message);
  }
}
