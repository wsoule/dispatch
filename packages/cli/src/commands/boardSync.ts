import type { Command } from 'commander';

import type { ApiClient, SyncStatus } from '../apiClient.js';
import { createApiClient } from '../apiClient.js';
import type { CliContext } from '../context.js';
import { attachToRunningDaemon, resolveAppToken } from './appToken.js';

/** Board sync's state as a few lines a person can read at a glance. */
export function describeSync(
  status: SyncStatus,
  opts: { now?: Date; originWarning?: string | null } = {}
): string[] {
  if (!status.enabled) {
    switch (status.reason) {
      case 'files':
        return [
          "Board sync isn't available: it shares boards kept in Dispatch's database, and this project keeps its tasks as files.",
          'They reach teammates through "Commit task files to the main branch". The person running Dispatch for this project turns it on in Settings → Board sync, or with `autoCommit: true` in .dispatch/config.yml.',
        ];
      case 'no-place':
        return [
          'Board sync is on but no place is set, so nothing is pushed: Dispatch never pushes to a remote nobody chose.',
          "Choose one in Settings → Board sync, or set `sync.remote` (one of this project's remotes) or `sync.repo` in .dispatch/config.yml, then restart Dispatch for this project.",
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
  if (status.restartRequired !== undefined) lines.push(status.restartRequired);
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
  if (status.founded === true && status.teamId != null)
    lines.push(
      `Team ${status.teamId.slice(0, 8)}…, over ${status.transport ?? 'git'}.`
    );
  if (status.legacyUntil != null) {
    const now = (opts.now ?? new Date()).getTime();
    const days = Math.ceil(
      (Date.parse(status.legacyUntil) - now) / (24 * 60 * 60 * 1000)
    );
    if (days > 0)
      lines.push(`Older Dispatch builds can sync for ${days} more days.`);
  }
  if (opts.originWarning != null) lines.push(opts.originWarning);
  if (status.running === true)
    lines.push('The sync is still running; it carries on in the background.');
  for (const problem of status.federationProblems ?? [])
    lines.push(`Team problem with ${problem.subject}: ${problem.message}`);
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

  // With the app token the decide-tier view: the team's problems, and the
  // origin warning from the team keys. Without one, the shared view.
  async function appClient(): Promise<ApiClient | null> {
    let token: string;
    try {
      token = resolveAppToken(undefined, 'dispatch sync status');
    } catch {
      return null;
    }
    const { baseUrl } = await attachToRunningDaemon(ctx);
    return createApiClient(baseUrl, token);
  }
  async function originWarning(api: ApiClient | null): Promise<string | null> {
    if (api === null) return null;
    try {
      return (await api.getTeamKeys()).originWarning;
    } catch {
      return null;
    }
  }

  sync
    .command('status')
    .description(
      'Show whether the board is syncing, and anything it could not resolve'
    )
    .option('--json')
    .action(async (opts: { json?: boolean }) => {
      const app = await appClient();
      const status = await (app ?? (await client())).getSyncStatus();
      if (opts.json === true) ctx.log(JSON.stringify(status, null, 2));
      else
        for (const line of describeSync(status, {
          originWarning: await originWarning(app),
        }))
          ctx.log(line);
    });

  sync
    .command('now')
    .description('Sync now instead of waiting for the next pass')
    .option('--json')
    .action(async (opts: { json?: boolean }) => {
      const status = await ((await appClient()) ?? (await client())).syncNow();
      if (opts.json === true) ctx.log(JSON.stringify(status, null, 2));
      else for (const line of describeSync(status)) ctx.log(line);
    });
}
