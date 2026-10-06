import { loadConfig, syncPlace, syncSettings } from '@dispatch-foo/core';
import { Command, Option } from 'commander';
import { createInterface } from 'node:readline';

import type {
  ApiClient,
  JoinedTeam,
  RosterAnswer,
  TeamInvite,
  TeamKeys,
  TeamStatus,
  TeamTier,
} from '../apiClient.js';
import { createApiClient } from '../apiClient.js';
import type { CliContext } from '../context.js';
import { CliError } from '../context.js';
import { formatTable } from '../output.js';
import {
  appTokenClient,
  attachToRunningDaemon,
  optionalAppToken,
} from './appToken.js';
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
      'Your team: start one, invite a teammate, join with a link, see how it is doing'
    )
    .addHelpText(
      'after',
      `
Two actions each:
  you        dispatch team start, then dispatch team invite <email or handle>
  teammate   dispatch team join   (and paste the link you sent them)

Shared-host tokens: dispatch team host --help
Machine keys, admits and the rest: dispatch team advanced --help`
    );
  registerTeamEssentials(team, ctx);

  const host = team
    .command('host')
    .description(
      'Advanced: daemon tokens for teammates who sign in to this shared daemon'
    );
  registerHostCommands(host, ctx, false);

  const advanced = team
    .command('advanced')
    .description(
      'Advanced: machine keys, admits, the recovery code, transports and problem notes'
    );
  registerFederationCommands(advanced, ctx, false);
  // The names these had before `advanced` and `host`, kept for scripts.
  registerFederationCommands(team, ctx, true);
  registerHostCommands(team, ctx, true, ['tokens', 'revoke']);
}

const DISCLOSURE_FALLBACK =
  'The relay can read everything that is not sealed: the board, team memory and team docs, the roster, presence, and who messaged whom and when. It cannot read message contents.';

// The relay's host as a person reads it.
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** `dispatch team status` as lines: the one-line summary, who is on the
 *  team with the optional check for each, and each problem with its fix. */
function describeTeamStatus(status: TeamStatus): string[] {
  const lines = [status.line];
  for (const t of status.teammates) {
    const who = `${t.handle}${t.device === '' ? '' : ` (${t.device})`}`;
    const extra = t.you ? 'you' : t.check === null ? '' : `check ${t.check}`;
    lines.push(`  ${who} · ${t.role}${extra === '' ? '' : ` · ${extra}`}`);
  }
  if (status.check !== null)
    lines.push(
      `Optional check: read "${status.check}" with whoever invited you; their status shows the same.`
    );
  if (status.problems.length > 0) {
    lines.push('Needs attention:');
    for (const p of status.problems) {
      lines.push(`  - ${p.message}`);
      if (p.fix !== null) lines.push(`    fix: ${p.fix}`);
    }
  }
  if (status.reduced === true)
    lines.push(
      'Teammates, checks and problems need the daemon app token: pass --token or set DISPATCH_APP_TOKEN.'
    );
  return lines;
}

// Asks a yes/no question on a terminal; false when nobody can answer.
// Joins, and when the daemon answers `confirm_repo` (the invite keeps the
// board on a local path or private host) says where and asks before
// retrying with consent; `--accept-repo` answers yes without a terminal.
async function joinConfirmingRepo(
  ctx: CliContext,
  api: ApiClient,
  code: string,
  accepted: boolean
): Promise<JoinedTeam> {
  try {
    return await api.joinTeam(code);
  } catch (err) {
    if (!(err instanceof CliError) || err.code !== 'confirm_repo') throw err;
    ctx.log(err.message);
    const yes =
      accepted ||
      (await (ctx.confirm ?? confirmNo)('Join and sync with that repo?'));
    if (!yes)
      throw new CliError(
        'Not joined. Ask whoever invited you where the board is kept, or run this again with --accept-repo.'
      );
    return await api.joinTeam(code, { confirmRepo: true });
  }
}

// Like defaultConfirm, but no is the default: this guards a risk.
async function confirmNo(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) return false;
  process.stderr.write(`${question} [y/N] `);
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.once('line', resolve)
    );
    return /^y/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function defaultConfirm(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) return false;
  process.stderr.write(`${question} [Y/n] `);
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.once('line', resolve)
    );
    return !/^n/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// Reads one line on a terminal; null when nobody can answer.
async function defaultAsk(question: string): Promise<string | null> {
  if (process.stdin.isTTY !== true) return null;
  process.stderr.write(question);
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    return await new Promise<string>((resolve) => rl.once('line', resolve));
  } finally {
    rl.close();
  }
}

const NO_PLACE_FLAGS =
  "Choose where the team's board is kept: --repo <git url> for a separate board repo (recommended), or --remote origin for a dispatch-sync branch on this project's repo.";

// Where `team start` keeps the board when no flag and no config names a
// place: asked on a terminal, refused with the flags otherwise. Null when
// config.yml already names one (or can't be read: the daemon then decides).
async function startPlace(
  ctx: CliContext
): Promise<{ remote: string } | { repo: string } | null> {
  try {
    if (syncPlace(syncSettings(loadConfig(ctx.cwd))) !== null) return null;
  } catch {
    return null;
  }
  const ask = ctx.ask ?? defaultAsk;
  const choice = await ask(
    "Where should the team's board be kept?\n  1) A separate board repo (recommended)\n  2) This project's origin remote, on branch dispatch-sync\nChoose 1 or 2: "
  );
  if (choice === null) throw new CliError(NO_PLACE_FLAGS);
  if (choice.trim() === '2') return { remote: 'origin' };
  if (choice.trim() !== '1') throw new CliError(NO_PLACE_FLAGS);
  const repo = (await ask('Board repo URL: '))?.trim() ?? '';
  if (repo === '') throw new CliError(NO_PLACE_FLAGS);
  return { repo };
}

// start / invite / join / status / leave: the whole of setting a team up.
function registerTeamEssentials(team: Command, ctx: CliContext): void {
  const tokenOption = '--token <token>';
  const tokenHelp = 'the daemon app token (or DISPATCH_APP_TOKEN)';
  const client = (opts: { token?: string }, command: string) =>
    appTokenClient(ctx, opts.token, command);

  team
    .command('start')
    .description(
      'Start a team with this machine as its first admin, syncing through the hosted relay (or --git)'
    )
    .option('--name <team>', 'the team name (default: the project folder)')
    .option('--git', 'sync over a git branch instead of the relay')
    .option(
      '--remote <name>',
      "keep the team's board on a branch of one of this project's remotes (like origin)"
    )
    .option(
      '--repo <url>',
      "keep the team's board in a repository of its own (a git URL or path)"
    )
    .option(
      '--relay <url>',
      'another relay (default: DISPATCH_RELAY_URL, or wss://relay.dispatch.foo)'
    )
    .option(
      '--registration-token [token]',
      "a self-hosted relay's registration token; with no value, read from stdin or a prompt that does not echo"
    )
    .option(
      '--yes',
      'use the relay without asking, having read what it can see'
    )
    .option(tokenOption, tokenHelp)
    .option('--json')
    .action(
      async (opts: {
        name?: string;
        git?: boolean;
        remote?: string;
        repo?: string;
        relay?: string;
        registrationToken?: string | true;
        yes?: boolean;
        token?: string;
        json?: boolean;
      }) => {
        const api = await client(opts, 'dispatch team start');
        const git = opts.git === true;
        if (git && opts.relay !== undefined)
          throw new CliError('Pick one: --git or --relay <url>.');
        if (opts.remote !== undefined && opts.repo !== undefined)
          throw new CliError('Pick one: --remote <name> or --repo <url>.');
        const place =
          opts.remote !== undefined
            ? { remote: opts.remote }
            : opts.repo !== undefined
              ? { repo: opts.repo }
              : await startPlace(ctx);
        let confirmed = false;
        if (!git) {
          const where = hostOf(opts.relay ?? 'wss://relay.dispatch.foo');
          if (opts.yes === true) confirmed = true;
          else {
            const disclosure = await api
              .getTeamKeys()
              .then((k) => k.relayDisclosure)
              .catch(() => DISCLOSURE_FALLBACK);
            ctx.log(disclosure);
            confirmed = await (ctx.confirm ?? defaultConfirm)(
              `Sync this team through ${where}?`
            );
            if (!confirmed)
              throw new CliError(
                'Not started. Run it again with --yes to use the relay, or --git to sync over git.'
              );
          }
          ctx.log(`Registering with ${where}…`);
        }
        const given = opts.registrationToken;
        const registrationToken =
          given === undefined
            ? undefined
            : given === true
              ? await readSecret(ctx, 'Relay registration token: ')
              : given;
        const started = await api.startTeam({
          ...(opts.name === undefined ? {} : { name: opts.name }),
          ...(place ?? {}),
          ...(git ? { git: true } : { confirmed }),
          ...(opts.relay === undefined ? {} : { relayUrl: opts.relay }),
          ...(registrationToken === undefined ? {} : { registrationToken }),
        });
        if (opts.json === true) {
          ctx.log(JSON.stringify(started, null, 2));
          return;
        }
        ctx.log(
          started.transport.kind === 'relay'
            ? `Started team '${started.name}', syncing via ${hostOf(started.transport.url ?? '')}.`
            : `Started team '${started.name}', syncing over git.`
        );
        if (started.notice !== null) ctx.log(started.notice);
        logAnswer(ctx, started);
        ctx.log('');
        ctx.log(`  Recovery code: ${started.recoveryCode}`);
        ctx.log('');
        ctx.log(
          'Store this where you keep other recovery codes; it is the only way back in if every admin machine is lost.'
        );
        ctx.log('Next: dispatch team invite <email or handle>');
      }
    );

  team
    .command('invite <emailOrHandle>')
    .description(
      'Make a one-time link a teammate joins with; send it to them privately'
    )
    .option(tokenOption, tokenHelp)
    .option('--json')
    // The shared-host token options this command once took (`team host invite`).
    .addOption(new Option('--name <displayName>').hideHelp())
    .addOption(new Option('--tier <tier>').hideHelp())
    .addOption(new Option('--expires <days>').hideHelp())
    .action(
      async (
        who: string,
        opts: {
          token?: string;
          json?: boolean;
          name?: string;
          tier?: string;
          expires?: string;
        }
      ) => {
        if (
          opts.name !== undefined ||
          opts.tier !== undefined ||
          opts.expires !== undefined
        ) {
          ctx.log(
            'A daemon token for a shared host is `dispatch team host invite` now; issuing one.'
          );
          await issueHostToken(ctx, who, opts);
          return;
        }
        const api = await client(opts, 'dispatch team invite');
        let invite: TeamInvite;
        try {
          invite = await api.inviteToTeam(who);
        } catch (err) {
          if ((err as Error).message.includes('board sync is not on'))
            throw new CliError(
              'Board sync is off here, so there is no team to invite to. Start one with `dispatch team start`; for a daemon token on a shared host, run `dispatch team host invite`.'
            );
          throw err;
        }
        if (opts.json === true) {
          ctx.log(JSON.stringify(invite, null, 2));
          return;
        }
        const link = invite.link ?? invite.code;
        ctx.log(
          `Invite for ${invite.handle}, good once until ${invite.expires.slice(0, 10)}:`
        );
        ctx.log('');
        ctx.log(`  ${link}`);
        ctx.log('');
        ctx.log(
          `Send this privately: anyone holding it can join as ${invite.handle} until ${invite.expires.slice(0, 10)}. ${invite.handle} runs \`dispatch team join\` and pastes it, or pastes it in Settings → Team.`
        );
        if (invite.url !== undefined) ctx.log(`As a URL: ${invite.url}`);
        logAnswer(ctx, invite);
      }
    );

  team
    .command('join [link]')
    .description(
      'Join a team with the link a teammate sent you, pasted at the prompt (or piped in)'
    )
    .option(
      '--accept-repo',
      "join even when the invite's board repo is on this machine or a private network"
    )
    .option(tokenOption, tokenHelp)
    .option('--json')
    .action(
      async (
        given: string | undefined,
        opts: { token?: string; json?: boolean; acceptRepo?: boolean }
      ) => {
        // M2: an invite is a secret, so it is never taken from argv, where
        // shell history and ps keep it.
        if (given !== undefined)
          throw new CliError(
            'Paste the link at the prompt instead: `dispatch team join`, then paste. An invite is a secret, and arguments stay in shell history.'
          );
        // The token and daemon first, so a missing one fails before the
        // person has pasted a secret.
        const api = await client(opts, 'dispatch team join');
        const code = await readSecret(ctx, 'Invite link: ');
        const joined = await joinConfirmingRepo(
          ctx,
          api,
          code,
          opts.acceptRepo === true
        );
        if (opts.json === true) {
          ctx.log(JSON.stringify(joined, null, 2));
          return;
        }
        logAnswer(ctx, joined);
        const name = joined.team?.name;
        if (name === undefined || name === null) {
          // An older `di1.` code: its admin compares fingerprints.
          const { machine } = await api.getTeamKeys();
          ctx.log(
            `Asked to join. Read this machine's fingerprint to an admin, who admits it once theirs shows the same: ${machine.fingerprint}`
          );
          return;
        }
        ctx.log(
          `Joined team '${name}'. ${joined.by ?? 'Your inviter'}'s Dispatch lets this machine in on its next sync; \`dispatch team status\` shows when.`
        );
        if (joined.check !== undefined)
          ctx.log(
            `Optional check: read "${joined.check}" with ${joined.by ?? 'them'}; their \`dispatch team status\` shows the same next to your name.`
          );
      }
    );

  team
    .command('status')
    .description('The team in one line, and anything that needs attention')
    .option(
      tokenOption,
      'the daemon app token (or DISPATCH_APP_TOKEN); without it, the summary line alone'
    )
    .option('--json')
    .action(async (opts: { token?: string; json?: boolean }) => {
      // Without an app token, the agent token's reduced view: where this
      // machine stands, so someone stuck without a token can still see it.
      const { baseUrl, agentToken } = await attachToRunningDaemon(ctx);
      const appToken = optionalAppToken(opts.token);
      const status = await createApiClient(
        baseUrl,
        appToken ?? agentToken
      ).getTeamStatus();
      if (opts.json === true) ctx.log(JSON.stringify(status, null, 2));
      else for (const line of describeTeamStatus(status)) ctx.log(line);
    });

  team
    .command('agents')
    .description(
      "Every agent address you can message: this machine's and teammates' synced ones"
    )
    .option('--all', 'include revoked agents')
    .option('--json')
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      // The roster is a request-tier read: the daemon file's token is enough.
      const { baseUrl, agentToken } = await attachToRunningDaemon(ctx);
      const { agents } = await createApiClient(
        baseUrl,
        agentToken
      ).listAgentRoster();
      const shown = agents
        .filter((a) => opts.all === true || a.status !== 'revoked')
        .sort((a, b) => a.address.localeCompare(b.address));
      if (opts.json === true) {
        ctx.log(JSON.stringify(shown, null, 2));
        return;
      }
      if (shown.length === 0) {
        ctx.log('No agents are registered.');
        return;
      }
      ctx.log(
        formatTable([
          ['ADDRESS', 'STATUS', 'MACHINE', 'CLIENT'],
          ...shown.map((a) => [
            a.address,
            a.status,
            a.remote ?? 'this machine',
            a.client,
          ]),
        ])
      );
      ctx.log('');
      ctx.log(
        "To reach work on a teammate's machine, message its task:<id> or run:<id>."
      );
    });

  team
    .command('leave')
    .description(
      'Stop waiting to join a team; a machine already in one is removed by an admin'
    )
    .option(tokenOption, tokenHelp)
    .action(async (opts: { token?: string }) => {
      await (await client(opts, 'dispatch team leave')).leaveTeam();
      ctx.log('Let go of the invite; this machine is in no team now.');
    });
}

// `dispatch team host invite`: a daemon token for a teammate on this
// shared daemon, shown once.
async function issueHostToken(
  ctx: CliContext,
  who: string,
  opts: {
    name?: string;
    tier?: string;
    expires?: string;
    token?: string;
    json?: boolean;
  }
): Promise<void> {
  const client = await appTokenClient(
    ctx,
    opts.token,
    'dispatch team host invite'
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

/** The shared-host token commands: invite, tokens, revoke. `only` names the
 *  ones to register (hidden aliases under `team` keep two old names). */
function registerHostCommands(
  parent: Command,
  ctx: CliContext,
  hidden: boolean,
  only?: readonly string[]
): void {
  const want = (name: string) => only === undefined || only.includes(name);
  if (want('invite'))
    parent
      .command('invite <emailOrHandle>', { hidden })
      .description(
        'Issue a teammate a token for this shared daemon (adds them to team.yml when given an email)'
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
          await issueHostToken(ctx, who, opts);
        }
      );

  if (want('tokens'))
    parent
      .command('tokens', { hidden })
      .description('List who holds a credential (never the credentials)')
      .option('--token <token>', 'the daemon app token (or DISPATCH_APP_TOKEN)')
      .option('--json')
      .action(async (opts: { token?: string; json?: boolean }) => {
        const client = await appTokenClient(
          ctx,
          opts.token,
          'dispatch team host tokens'
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
              h.builtIn
                ? 'daemon'
                : h.unusable === true
                  ? 'unusable'
                  : 'issued',
              day(h.issuedAt),
              h.expired ? `expired ${day(h.expiresAt)}` : day(h.expiresAt),
              day(h.lastUsedAt),
            ]),
          ])
        );
      });

  if (want('revoke'))
    parent
      .command('revoke <handle>', { hidden })
      .description(
        "Revoke a teammate's daemon token; it stops working immediately"
      )
      .option('--token <token>', 'the daemon app token (or DISPATCH_APP_TOKEN)')
      .action(async (handle: string, opts: { token?: string }) => {
        const client = await appTokenClient(
          ctx,
          opts.token,
          'dispatch team host revoke'
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
  lines.push(
    keys.transport.kind === 'relay'
      ? `Syncing over the relay at ${keys.transport.url ?? 'an unknown URL'}.`
      : 'Syncing over git.'
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

/**
 * `dispatch team transport relay <url> [--yes] [--registration-token] | git`:
 * a switch to the relay first prints what the relay can read, and switches
 * only with --yes (F-D31). The daemon registers the team at the relay before
 * it signs the switch; `registrationToken`, asked for only once --yes is
 * given, rides that registration alone.
 */
export async function switchTeamTransport(
  api: Pick<ApiClient, 'getTeamKeys' | 'switchTransport'>,
  kind: 'git' | 'relay',
  url: string | undefined,
  yes: boolean,
  log: (line: string) => void,
  registrationToken?: () => Promise<string | undefined>
): Promise<RosterAnswer> {
  if (kind === 'git') {
    if (registrationToken !== undefined)
      throw new CliError('A registration token is for a switch to the relay.');
    return await api.switchTransport({ kind: 'git' });
  }
  if (url === undefined || url === '')
    throw new CliError('Name the relay: dispatch team transport relay <url>');
  if (!yes) {
    log((await api.getTeamKeys()).relayDisclosure);
    throw new CliError('Run it again with --yes to switch.');
  }
  const token = await registrationToken?.();
  return await api.switchTransport({
    kind: 'relay',
    url,
    confirmed: true,
    ...(token === undefined ? {} : { registrationToken: token }),
  });
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
 *  rest, under `team advanced` (and, hidden, under `team` by their old
 *  names). Each signs with this machine's key, so each takes the app token. */
function registerFederationCommands(
  team: Command,
  ctx: CliContext,
  hidden: boolean
): void {
  // Under `team` itself, `join` is the essential command, which takes an
  // older code as well as a link.
  const sub = (spec: string): Command =>
    hidden && spec === 'join'
      ? new Command('join').allowExcessArguments(false)
      : team.command(spec, { hidden });
  const tokenOption = '--token <token>';
  const tokenHelp = 'the daemon app token (or DISPATCH_APP_TOKEN)';
  const client = (opts: { token?: string }, command: string) =>
    appTokenClient(ctx, opts.token, command);

  sub('found')
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

  sub('trust <fingerprint>')
    .description('Follow the founding with this fingerprint')
    .option(tokenOption, tokenHelp)
    .action(async (fingerprint: string, opts: { token?: string }) => {
      await (
        await client(opts, 'dispatch team trust')
      ).trustFounder(fingerprint);
      ctx.log(`Following the founding ${fingerprint}.`);
    });

  sub('join')
    .description(
      'Ask to join a team with an invite code, read from stdin or a prompt'
    )
    .option(tokenOption, tokenHelp)
    .allowExcessArguments(false)
    .action(async (opts: { token?: string }) => {
      const api = await client(opts, 'dispatch team join');
      const code = await readSecret(ctx, 'Invite code: ');
      logAnswer(ctx, await api.joinTeam(code));
      const { machine } = await api.getTeamKeys();
      ctx.log(
        `Asked to join. Read this machine's fingerprint to an admin, who admits it once theirs shows the same: ${machine.fingerprint}`
      );
    });

  sub('abandon-invite')
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

  sub('recover')
    .description(
      'Rejoin as an admin with the recovery code, read from stdin or a prompt'
    )
    .option(tokenOption, tokenHelp)
    .allowExcessArguments(false)
    .action(async (opts: { token?: string }) => {
      const api = await client(opts, 'dispatch team recover');
      const code = await readSecret(ctx, 'Recovery code: ');
      logAnswer(ctx, await api.recoverTeam(code));
      ctx.log('Recovered: this machine is an admin, ranked after every other.');
    });

  sub('recovery-key')
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

  sub('license')
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

  sub('close-legacy')
    .description('Stop syncing with older Dispatch builds now')
    .option(tokenOption, tokenHelp)
    .action(async (opts: { token?: string }) => {
      await (await client(opts, 'dispatch team close-legacy')).closeLegacy();
      ctx.log('Closed the legacy window: older builds no longer sync.');
    });

  sub('transport <kind> [url]')
    .description(
      'Switch the team to a relay (relay <url> --yes) or back to git. The switch registers the team at the relay first; a relay that wants a registration token takes it with --registration-token, used for that one request and never stored'
    )
    .option('--yes', 'Switch, having read what the relay can see')
    .option(
      '--registration-token [token]',
      "the relay's registration token; with no value, read from stdin or a prompt that does not echo"
    )
    .option(tokenOption, tokenHelp)
    .action(
      async (
        kind: string,
        url: string | undefined,
        opts: {
          token?: string;
          yes?: boolean;
          registrationToken?: string | true;
        }
      ) => {
        if (kind !== 'relay' && kind !== 'git')
          throw new CliError(`kind must be relay or git, not "${kind}"`);
        const given = opts.registrationToken;
        const registrationToken =
          given === undefined
            ? undefined
            : given === true
              ? () => readSecret(ctx, 'Relay registration token: ')
              : () => Promise.resolve(given);
        const api = await client(opts, 'dispatch team transport');
        logAnswer(
          ctx,
          await switchTeamTransport(
            api,
            kind,
            url,
            opts.yes === true,
            (l) => ctx.log(l),
            registrationToken
          )
        );
        ctx.log(
          kind === 'relay'
            ? 'Switched the team to the relay; every machine follows on its next sync.'
            : 'Switched the team back to git; every machine follows on its next sync.'
        );
      }
    );

  sub('dismiss <replica> <seq> <hash>')
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

  sub('resolve-run <run> <replica>')
    .description(
      'Bind a run two machines each claim first to one of them (an admin, decide tier); no machine is revoked'
    )
    .option(tokenOption, tokenHelp)
    .action(async (run: string, replica: string, opts: { token?: string }) => {
      logAnswer(
        ctx,
        await (
          await client(opts, 'dispatch team resolve-run')
        ).resolveRunConflict(run, replica)
      );
      ctx.log(`Run ${run} now runs on ${replica}.`);
    });

  sub('ack <subject>')
    .description(
      'Acknowledge a race, cut, merge, route, observer or slow-read note (the subject `team keys` lists); a halt or pause goes only when its cause does'
    )
    .option(tokenOption, tokenHelp)
    .action(async (subject: string, opts: { token?: string }) => {
      await (await client(opts, 'dispatch team ack')).ackProblem(subject);
      ctx.log(`Acknowledged ${subject}.`);
    });

  const keys = sub('keys')
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
