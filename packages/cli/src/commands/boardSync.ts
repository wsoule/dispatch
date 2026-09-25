import type { Command } from 'commander';

import type { SyncStatus } from '../apiClient.js';
import { createApiClient } from '../apiClient.js';
import type { CliContext } from '../context.js';
import { attachToRunningDaemon } from './appToken.js';

/** Board sync's state as a few lines a person can read at a glance. */
export function describeSync(status: SyncStatus): string[] {
  if (!status.enabled) {
    switch (status.reason) {
      case 'files':
        return [
          "Board sync isn't available: it shares boards kept in Dispatch's database, and this project keeps its tasks as files.",
          'They reach teammates through "Commit task files to the main branch". The person running Dispatch for this project turns it on in Settings → Board sync, or with `autoCommit: true` in .dispatch/config.yml.',
        ];
      case 'not-started':
        return [
          "Board sync is on but isn't running: its remote or repo couldn't be resolved when Dispatch started, or it was turned on since.",
          'Check `sync.remote` or `sync.repo` in Settings → Board sync, then restart Dispatch for this project.',
        ];
      default:
        return [
          'Board sync is off. It shares a database-backed project with teammates.',
          'The person running Dispatch for this project can turn it on in Settings → Board sync, or with `sync: { enabled: true }` in .dispatch/config.yml, then restart Dispatch.',
        ];
    }
  }
  const lines = [
    `Syncing as ${status.replica}, on ${status.branch} of ${status.remote}`,
    status.lastSyncAt === null
      ? 'Not synced yet.'
      : `Last synced ${status.lastSyncAt}.`,
  ];
  if (status.paused !== null) lines.push(status.paused);
  if (status.lastError !== null) {
    lines.push(`The remote could not be reached: ${status.lastError}`);
    lines.push(
      'Work carries on here and is sent on the next pass that can reach it.'
    );
  }
  if (status.pending > 0)
    lines.push(`${status.pending} change(s) waiting to be sent.`);
  for (const problem of status.problems) {
    lines.push(`Problem with ${problem.task}: ${problem.message}`);
  }
  return lines;
}

export function registerBoardSyncCommands(
  program: Command,
  ctx: CliContext
): void {
  const sync = program
    .command('sync')
    .description("Share this board with teammates' daemons over git");

  async function client() {
    const { baseUrl, agentToken } = await attachToRunningDaemon(ctx);
    return createApiClient(baseUrl, agentToken);
  }

  sync
    .command('status')
    .description(
      'Show whether the board is syncing, and anything it could not resolve'
    )
    .option('--json')
    .action(async (opts: { json?: boolean }) => {
      const status = await (await client()).getSyncStatus();
      if (opts.json === true) ctx.log(JSON.stringify(status, null, 2));
      else for (const line of describeSync(status)) ctx.log(line);
    });

  sync
    .command('now')
    .description('Sync now instead of waiting for the next pass')
    .option('--json')
    .action(async (opts: { json?: boolean }) => {
      const status = await (await client()).syncNow();
      if (opts.json === true) ctx.log(JSON.stringify(status, null, 2));
      else for (const line of describeSync(status)) ctx.log(line);
    });
}
