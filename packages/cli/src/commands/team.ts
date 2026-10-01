import type { Command } from 'commander';

import type { TeamTier } from '../apiClient.js';
import type { CliContext } from '../context.js';
import { CliError } from '../context.js';
import { formatTable } from '../output.js';
import { appTokenClient } from './appToken.js';

const TIERS: readonly TeamTier[] = ['request', 'decide', 'operator'];

/** `--tier` as typed, checked here so a typo fails before the daemon is
 *  asked, with the choices spelled out. */
function tierFrom(value: string | undefined): TeamTier {
  const tier = value ?? 'request';
  if (!(TIERS as readonly string[]).includes(tier)) {
    throw new CliError(
      `unknown tier "${tier}": use request, decide or operator`
    );
  }
  return tier as TeamTier;
}

/** `--expires` as typed: a number of days, `never`, or absent for the
 *  daemon's default (90 days). */
function expiryFrom(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === 'never') return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1) {
    throw new CliError(
      `--expires takes a number of days or "never", not "${value}"`
    );
  }
  return days;
}

/** A timestamp as a table cell: the date alone, which is what someone
 *  scanning for stale or expiring tokens needs. */
function day(iso: string | null): string {
  return iso === null ? '-' : iso.slice(0, 10);
}

// Every team command is decide-tier, since handing out a credential is an
// adjudication, so each talks through the app token.
export function registerTeamCommands(program: Command, ctx: CliContext): void {
  const team = program
    .command('team')
    .description('Give teammates their own credential for a shared daemon');

  team
    .command('invite <emailOrHandle>')
    .description(
      'Issue a teammate a token (adds them to team.yml when given an email)'
    )
    .option('--name <displayName>', 'display name for a new roster entry')
    .option(
      '--tier <tier>',
      'request (default: board, dispatch, review, merge), decide (+ approvals, scope decisions, previews, invites) or operator (+ terminals, browser, file writes and git on this machine)'
    )
    .option(
      '--expires <days>',
      'days until the token stops working, or "never" (default 90)'
    )
    .option('--token <token>', 'the daemon app token (or DISPATCH_APP_TOKEN)')
    .option('--json')
    .action(
      async (
        who: string,
        opts: {
          name?: string;
          tier?: string;
          expires?: string;
          token?: string;
          json?: boolean;
        }
      ) => {
        const client = await appTokenClient(
          ctx,
          opts.token,
          'dispatch team invite'
        );
        const tier = tierFrom(opts.tier);
        const expiresInDays = expiryFrom(opts.expires);
        const issued = await client.issueTeamToken(
          who.includes('@')
            ? { email: who, displayName: opts.name, tier, expiresInDays }
            : { handle: who, tier, expiresInDays }
        );
        if (opts.json === true) {
          ctx.log(JSON.stringify(issued, null, 2));
          return;
        }
        // Said once, plainly: the daemon keeps only a hash, so this line is
        // the only place the token will ever be shown.
        ctx.log(
          `issued ${issued.tier} token for ${issued.handle}, ${issued.expiresAt === null ? 'never expiring' : `expiring ${day(issued.expiresAt)}`}`
        );
        ctx.log('');
        ctx.log(`  ${issued.token}`);
        ctx.log('');
        ctx.log(
          'Send it to them privately. It is not stored anywhere readable and cannot be shown again; re-run this command to replace it.'
        );
      }
    );

  team
    .command('tokens')
    .description('List who holds a credential (never the credentials)')
    .option('--token <token>', 'the daemon app token (or DISPATCH_APP_TOKEN)')
    .option('--json')
    .action(async (opts: { token?: string; json?: boolean }) => {
      const client = await appTokenClient(
        ctx,
        opts.token,
        'dispatch team tokens'
      );
      const holders = await client.listTeamTokens();
      if (opts.json === true) {
        ctx.log(JSON.stringify(holders, null, 2));
        return;
      }
      ctx.log(
        formatTable([
          ['HANDLE', 'TIER', 'KIND', 'ISSUED', 'EXPIRES', 'LAST USED'],
          ...holders.map((h) => [
            h.handle,
            h.tier,
            h.builtIn ? 'daemon' : h.unusable === true ? 'unusable' : 'issued',
            day(h.issuedAt),
            h.expired ? `expired ${day(h.expiresAt)}` : day(h.expiresAt),
            day(h.lastUsedAt),
          ]),
        ])
      );
    });

  team
    .command('revoke <handle>')
    .description("Revoke a teammate's token; it stops working immediately")
    .option('--token <token>', 'the daemon app token (or DISPATCH_APP_TOKEN)')
    .action(async (handle: string, opts: { token?: string }) => {
      const client = await appTokenClient(
        ctx,
        opts.token,
        'dispatch team revoke'
      );
      try {
        await client.revokeTeamToken(handle);
      } catch (err) {
        throw new CliError(
          `could not revoke ${handle}'s token: ${(err as Error).message}`
        );
      }
      ctx.log(`revoked ${handle}'s token`);
    });
}
