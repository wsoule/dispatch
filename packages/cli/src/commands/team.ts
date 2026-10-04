import type { Command } from 'commander';

import type { RosterAnswer, TeamKeys, TeamTier } from '../apiClient.js';
import type { CliContext } from '../context.js';
import { CliError } from '../context.js';
import { formatTable } from '../output.js';
import { appTokenClient } from './appToken.js';
import { readSecret } from './secret.js';

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

// Every team command talks through the app token: handing out a credential
// is decide-tier, and changing the signed team is operator-tier.
export function registerTeamCommands(program: Command, ctx: CliContext): void {
  const team = program
    .command('team')
    .description(
      'Teammates: daemon tokens for a shared daemon, and the signed team of machines that sync this board'
    );

  team
    .command('invite <emailOrHandle>')
    .description(
      "Issue a teammate a daemon token (adds them to team.yml when given an email); for a machine's invite code, see `team keys invite`"
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
            h.builtIn ? 'daemon' : 'issued',
            day(h.issuedAt),
            h.expired ? `expired ${day(h.expiresAt)}` : day(h.expiresAt),
            day(h.lastUsedAt),
          ]),
        ])
      );
    });

  team
    .command('revoke <handle>')
    .description(
      "Revoke a teammate's daemon token; it stops working immediately. To remove a machine from the signed team, see `team keys revoke`"
    )
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

  registerFederationCommands(team, ctx);
}

/** `dispatch team keys` as lines: this machine, the team and its founder to
 *  verify, the roster, who is waiting, and what needs attention. */
export function describeTeamKeys(keys: TeamKeys): string[] {
  const { machine, team } = keys;
  const lines = [
    `This machine: ${machine.fingerprint} (${machine.handle} on ${machine.device}, ${machine.replica})`,
  ];
  if (team === null) {
    lines.push('No team is founded on this branch yet.');
    if (keys.foundings.length > 1) {
      lines.push(
        'Two or more foundings are on the branch; pick the one to follow with `dispatch team trust <fingerprint>`:'
      );
      for (const f of keys.foundings)
        lines.push(`  ${f.replica}: ${f.fingerprint}`);
    }
  } else {
    const { founder } = team;
    lines.push(`Team ${team.name} (${team.id.slice(0, 8)}…)`);
    lines.push(
      `Founder: ${founder.handle} (${founder.fingerprint}), verify this with ${founder.handle}`
    );
  }
  for (const m of keys.roster) {
    const role = m.observer ? 'observer' : m.role;
    const extra = m.hosts.length > 0 ? `, hosts ${m.hosts.join(', ')}` : '';
    lines.push(
      `  ${m.handle} on ${m.device} (${m.replica}): ${role}${m.recovered ? ' (recovered)' : ''}${extra}, ${m.fingerprint}`
    );
  }
  for (const w of keys.waiting)
    lines.push(
      `Waiting to join: ${w.handle} on ${w.device} (${w.replica}), ${w.fingerprint}${w.invitedBy === null ? '' : `, invited by ${w.invitedBy}`}`
    );
  for (const i of keys.invites)
    lines.push(
      `Invite for ${i.handle} from ${i.by}, until ${i.expires.slice(0, 10)}`
    );
  if (keys.legacy.until !== null && !keys.legacy.closed)
    lines.push(
      `Older Dispatch builds can sync until ${keys.legacy.until.slice(0, 10)}.`
    );
  if (keys.license !== null)
    lines.push(
      `Seats: ${keys.license.seats}${keys.license.org === null ? ' (free plan)' : ` (licensed to ${keys.license.org}${keys.license.sharedBy === null ? '' : `, shared by ${keys.license.sharedBy}`})`}`
    );
  for (const b of keys.pruningBlockers)
    lines.push(
      `${b.handle} has not acknowledged since ${b.lastAck === null ? 'it was admitted' : b.lastAck.slice(0, 10)}; it blocks pruning. Revoke it?`
    );
  if (keys.transport.sizeBytes !== null)
    lines.push(
      `The sync branch holds ${(keys.transport.sizeBytes / (1024 * 1024)).toFixed(1)} MiB.`
    );
  lines.push(...keys.warnings);
  if (keys.originWarning !== null) lines.push(keys.originWarning);
  for (const p of keys.problems)
    lines.push(`Problem with ${p.subject}: ${p.message}`);
  return lines;
}

// A roster change's answer: its warning, and whether its sync still runs.
function logAnswer(ctx: CliContext, answer: RosterAnswer | void): void {
  if (answer === undefined) return;
  if (answer.already === true)
    ctx.log('The team already shows this; nothing new was signed.');
  if (answer.warning !== undefined) ctx.log(answer.warning);
  if (answer.pending === true)
    ctx.log(
      'The change is made on this machine; it goes out once a sync reaches the remote.'
    );
}

/** The signed team roster's commands: founding, joining, admission and the
 *  rest. Each signs with this machine's key, so each takes the app token. */
function registerFederationCommands(team: Command, ctx: CliContext): void {
  const tokenOption = '--token <token>';
  const tokenHelp = 'the daemon app token (or DISPATCH_APP_TOKEN)';
  const client = (opts: { token?: string }, command: string) =>
    appTokenClient(ctx, opts.token, command);

  team
    .command('found')
    .description(
      'Found a team on this branch, with this machine as its first admin'
    )
    .option('--name <team>', 'the team name (default: the project folder)')
    .option(tokenOption, tokenHelp)
    .action(async (opts: { name?: string; token?: string }) => {
      const api = await client(opts, 'dispatch team found');
      const founded = await api.foundTeam(opts.name);
      logAnswer(ctx, founded);
      ctx.log(
        `Founded team ${founded.teamId.slice(0, 8)}…; this machine is ${founded.fingerprint}.`
      );
      ctx.log('');
      ctx.log(`  Recovery code: ${founded.recoveryCode}`);
      ctx.log('');
      ctx.log(
        'Store this where you keep other recovery codes; it is the only way back in if every admin machine is lost.'
      );
    });

  team
    .command('trust <fingerprint>')
    .description('Follow the founding with this fingerprint')
    .option(tokenOption, tokenHelp)
    .action(async (fingerprint: string, opts: { token?: string }) => {
      await (
        await client(opts, 'dispatch team trust')
      ).trustFounder(fingerprint);
      ctx.log(`Following the founding ${fingerprint}.`);
    });

  team
    .command('join')
    .description(
      'Ask to join a team with an invite code, read from stdin or a prompt'
    )
    .option(tokenOption, tokenHelp)
    .allowExcessArguments(false)
    .action(async (opts: { token?: string }) => {
      const code = await readSecret(ctx, 'Invite code: ');
      const api = await client(opts, 'dispatch team join');
      logAnswer(ctx, await api.joinTeam(code));
      const { machine } = await api.getTeamKeys();
      ctx.log(
        `Asked to join. Read this machine's fingerprint to an admin, who admits it once theirs shows the same: ${machine.fingerprint}`
      );
    });

  team
    .command('abandon-invite')
    .description('Let go of the invite this machine joined with')
    .option(tokenOption, tokenHelp)
    .action(async (opts: { token?: string }) => {
      await (
        await client(opts, 'dispatch team abandon-invite')
      ).abandonInvite();
      ctx.log(
        'Let go of the invite; the foundings on the branch decide again, or trust one.'
      );
    });

  team
    .command('recover')
    .description(
      'Rejoin as an admin with the recovery code, read from stdin or a prompt'
    )
    .option(tokenOption, tokenHelp)
    .allowExcessArguments(false)
    .action(async (opts: { token?: string }) => {
      const code = await readSecret(ctx, 'Recovery code: ');
      logAnswer(
        ctx,
        await (await client(opts, 'dispatch team recover')).recoverTeam(code)
      );
      ctx.log('Recovered: this machine is an admin, ranked after every other.');
    });

  team
    .command('recovery-key')
    .description('Replace the recovery code; the old one stops working')
    .option(tokenOption, tokenHelp)
    .action(async (opts: { token?: string }) => {
      const { recoveryCode } = await (
        await client(opts, 'dispatch team recovery-key')
      ).newRecoveryCode();
      ctx.log(`  Recovery code: ${recoveryCode}`);
      ctx.log(
        'Store this where you keep other recovery codes; it is the only way back in if every admin machine is lost.'
      );
    });

  team
    .command('license')
    .description("The team's license")
    .command('share')
    .description("Share this machine's license key with the team")
    .option(tokenOption, tokenHelp)
    .action(async (opts: { token?: string }) => {
      await (
        await client(opts, 'dispatch team license share')
      ).shareTeamLicense();
      ctx.log('Shared the license with the team.');
    });

  team
    .command('close-legacy')
    .description('Stop syncing with older Dispatch builds now')
    .option(tokenOption, tokenHelp)
    .action(async (opts: { token?: string }) => {
      await (await client(opts, 'dispatch team close-legacy')).closeLegacy();
      ctx.log('Closed the legacy window: older builds no longer sync.');
    });

  team
    .command('dismiss <replica> <seq> <hash>')
    .description('Take a roster op no build can read out of every build')
    .option(tokenOption, tokenHelp)
    .action(
      async (
        replica: string,
        seq: string,
        hash: string,
        opts: { token?: string }
      ) => {
        const n = Number(seq);
        if (!Number.isSafeInteger(n))
          throw new CliError(`seq must be a number, not "${seq}"`);
        logAnswer(
          ctx,
          await (
            await client(opts, 'dispatch team dismiss')
          ).dismissRosterOp(replica, n, hash)
        );
        ctx.log(`Dismissed ${replica}'s op at seq ${n}.`);
      }
    );

  team
    .command('ack <subject>')
    .description(
      'Acknowledge a race, cut, merge, route, observer or slow-read note (the subject `team keys` lists); a halt or pause goes only when its cause does'
    )
    .option(tokenOption, tokenHelp)
    .action(async (subject: string, opts: { token?: string }) => {
      await (await client(opts, 'dispatch team ack')).ackProblem(subject);
      ctx.log(`Acknowledged ${subject}.`);
    });

  const keys = team
    .command('keys')
    .description('Machines on the team, their fingerprints and who is waiting')
    .option(tokenOption, tokenHelp)
    .option('--json')
    .action(async (opts: { token?: string; json?: boolean }) => {
      const view = await (
        await client(opts, 'dispatch team keys')
      ).getTeamKeys();
      if (opts.json === true) ctx.log(JSON.stringify(view, null, 2));
      else for (const line of describeTeamKeys(view)) ctx.log(line);
    });

  keys
    .command('invite <handle>')
    .description(
      'Create an invite code for a new machine to join the signed team; a daemon token is `team invite`'
    )
    .option(tokenOption, tokenHelp)
    .action(async (handle: string, opts: { token?: string }) => {
      const invite = await (
        await client(opts, 'dispatch team keys invite')
      ).inviteToTeam(handle);
      ctx.log(`  ${invite.code}`);
      ctx.log(`Valid until ${invite.expires.slice(0, 10)}. Send it privately.`);
    });

  keys
    .command('admit <replica>')
    .description('Admit a waiting machine once its fingerprint matches')
    .requiredOption('--fingerprint <fp>', 'the fingerprint you compared')
    .option('--handle <handle>', 'admit it under another handle')
    .option('--admin', 'admit it as an admin')
    .option(
      '--hosts <handles>',
      'handles a shared host serves, comma-separated'
    )
    .option('--observer', 'admit it as an observer')
    .option(tokenOption, tokenHelp)
    .action(
      async (
        replica: string,
        opts: {
          fingerprint: string;
          handle?: string;
          admin?: boolean;
          hosts?: string;
          observer?: boolean;
          token?: string;
        }
      ) => {
        const answer = await (
          await client(opts, 'dispatch team keys admit')
        ).admitReplica(replica, {
          fingerprint: opts.fingerprint,
          ...(opts.handle === undefined ? {} : { handle: opts.handle }),
          role: opts.admin === true ? 'admin' : 'member',
          ...(opts.hosts === undefined
            ? {}
            : {
                hosts: opts.hosts
                  .split(',')
                  .map((h) => h.trim())
                  .filter((h) => h !== ''),
              }),
          ...(opts.observer === true ? { observer: true } : {}),
        });
        logAnswer(ctx, answer);
        ctx.log(`Admitted ${replica}.`);
      }
    );

  keys
    .command('revoke <replica>')
    .description(
      "Revoke a machine's key from the signed team for good; a daemon token is `team revoke`"
    )
    .option('--reason <text>', 'why, for the audit log')
    .option(tokenOption, tokenHelp)
    .action(
      async (replica: string, opts: { reason?: string; token?: string }) => {
        logAnswer(
          ctx,
          await (
            await client(opts, 'dispatch team keys revoke')
          ).revokeReplica(replica, opts.reason)
        );
        ctx.log(`Revoked ${replica}.`);
      }
    );

  keys
    .command('role <replica> <role>')
    .description('Make a machine a member or an admin')
    .option(tokenOption, tokenHelp)
    .action(async (replica: string, role: string, opts: { token?: string }) => {
      if (role !== 'member' && role !== 'admin')
        throw new CliError(`role is member or admin, not "${role}"`);
      logAnswer(
        ctx,
        await (
          await client(opts, 'dispatch team keys role')
        ).setReplicaRole(replica, role)
      );
      ctx.log(
        `${replica} is now ${role === 'admin' ? 'an admin' : 'a member'}.`
      );
    });

  keys
    .command('hosts <replica> [handles...]')
    .description('Set the handles a shared host serves (none clears them)')
    .option(tokenOption, tokenHelp)
    .action(
      async (replica: string, handles: string[], opts: { token?: string }) => {
        logAnswer(
          ctx,
          await (
            await client(opts, 'dispatch team keys hosts')
          ).setReplicaHosts(replica, handles)
        );
        ctx.log(
          `${replica} hosts ${handles.length === 0 ? 'nobody' : handles.join(', ')}.`
        );
      }
    );
}
