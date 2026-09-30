import {
  absoluteGitLocation,
  DEFAULT_RECEIPTS_BRANCH,
  DOCS_LIMITS,
  formatMigrationReport,
  initProjectStores,
  MEMORY_RECEIPT_FILE_BYTES,
  restoreReceipts,
  writeProjectBackend,
} from '@dispatch/core';
import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CliContext } from '../context.js';
import { CliError } from '../context.js';
import { projectRoot } from '../projectRoot.js';
import { daemonFileKey, daemonHome, findRunningDaemon } from './daemon.js';

/**
 * The location a `--from` names, absolute: one of this project's remotes when
 * it is one (a relative URL on it read from the project root, where git reads
 * it), otherwise a URL or a path — a path meaning from where you typed it.
 * The clone runs in a temp dir, where a relative path would mean nothing.
 */
function remoteUrl(root: string, cwd: string, from: string): string {
  const res = spawnSync('git', ['remote', 'get-url', '--', from], {
    cwd: root,
    encoding: 'utf8',
  });
  if (res.status === 0) return absoluteGitLocation(root, res.stdout.trim());
  return absoluteGitLocation(cwd, from);
}

// Copies the clone's regular `.dispatch/<kind>/*.md` files, each within
// `limit`, to the daemon's run-state `<kind>-restore/` (0700); a symlink is refused.
function stageReceiptFiles(
  clone: string,
  root: string,
  kind: 'docs' | 'memory',
  limit: number
): { staged: number; problems: string[] } {
  const rel = `.dispatch/${kind}`;
  const from = join(clone, '.dispatch', kind);
  if (!existsSync(from)) return { staged: 0, problems: [] };
  if (!lstatSync(from).isDirectory()) {
    return {
      staged: 0,
      problems: [`${rel} is a symlink or not a directory; nothing staged`],
    };
  }
  const problems: string[] = [];
  const files = readdirSync(from)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => {
      const stat = lstatSync(join(from, f));
      if (!stat.isFile()) {
        problems.push(`${rel}/${f}: not a regular file; skipped`);
        return false;
      }
      if (stat.size > limit) {
        problems.push(`${rel}/${f}: over ${limit} bytes; skipped`);
        return false;
      }
      return true;
    });
  if (files.length === 0) return { staged: 0, problems };
  const to = join(
    daemonHome(),
    '.dispatch',
    'runs',
    daemonFileKey(root),
    `${kind}-restore`
  );
  mkdirSync(to, { recursive: true, mode: 0o700 });
  chmodSync(to, 0o700);
  for (const file of files) copyFileSync(join(from, file), join(to, file));
  return { staged: files.length, problems };
}

export function registerReceiptsCommands(
  program: Command,
  ctx: CliContext
): void {
  const receipts = program
    .command('receipts')
    .description("The board's audit log, and rebuilding a board from it");

  receipts
    .command('restore')
    .description(
      "Rebuild this machine's board from a receipt log another machine pushed"
    )
    .requiredOption('--from <urlOrRemote>', 'where the log was pushed')
    .option('--branch <name>', 'its branch', DEFAULT_RECEIPTS_BRANCH)
    .action((opts: { from: string; branch: string }) => {
      const root = projectRoot(ctx.cwd);
      return findRunningDaemon(ctx.cwd).then((daemon) => {
        // The daemon owns the database while it runs; writing under it would
        // race every request it serves.
        if (daemon !== null) {
          throw new CliError(
            `dispatchd is running for this project (port ${daemon.port}); stop it first, then restore`
          );
        }
        const url = remoteUrl(root, ctx.cwd, opts.from);
        const dir = mkdtempSync(join(tmpdir(), 'dispatch-receipts-restore-'));
        try {
          const cloned = spawnSync(
            'git',
            ['clone', '-q', '--depth', '1', '--branch', opts.branch, url, dir],
            { encoding: 'utf8' }
          );
          if (cloned.status !== 0) {
            throw new CliError(
              `could not fetch ${opts.branch} from ${url}: ${cloned.stderr.trim()}`
            );
          }
          const stores = initProjectStores({
            rootDir: root,
            backend: 'sqlite',
          });
          let result;
          try {
            // Adds what is missing and never overwrites: a task this board
            // already holds keeps its own version.
            result = restoreReceipts(dir, stores);
          } finally {
            stores.close();
          }
          ctx.log(formatMigrationReport(result.migration));
          ctx.log(
            `evidence: ${result.runs} run(s), ${result.commands} command(s), ${result.mutations} mutation(s)`
          );
          const docs = stageReceiptFiles(
            dir,
            root,
            'docs',
            DOCS_LIMITS.receiptFileBytes
          );
          if (docs.staged > 0)
            ctx.log(`staged ${docs.staged} doc(s) for the daemon to restore`);
          for (const problem of docs.problems) ctx.log(`problem: ${problem}`);
          // Team memory returns as proposals for a human, never as entries.
          const memory = stageReceiptFiles(
            dir,
            root,
            'memory',
            MEMORY_RECEIPT_FILE_BYTES
          );
          if (memory.staged > 0)
            ctx.log(
              `staged ${memory.staged} memory entr(ies) for the daemon to propose again`
            );
          for (const problem of memory.problems) ctx.log(`problem: ${problem}`);
          for (const problem of result.problems) {
            ctx.log(`problem: ${problem.source}: ${problem.detail}`);
          }
          if (
            result.problems.length === 0 &&
            result.migration.problems.length === 0
          ) {
            writeProjectBackend(root, 'sqlite');
            ctx.log('Restored. Start the daemon to serve this board.');
          } else {
            ctx.log(
              'Restored with the problems above; the project is not yet marked as database-backed. Fix them and run this again.'
            );
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
}
