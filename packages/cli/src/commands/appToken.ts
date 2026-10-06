import type { ApiClient } from '../apiClient.js';
import { createApiClient } from '../apiClient.js';
import { type CliContext, CliError } from '../context.js';
import { type DaemonConnection, findRunningDaemon } from './daemon.js';
import { requireInitialized } from './task.js';

const NO_DAEMON_MESSAGE =
  'no dispatchd is running for this project — start one with: dispatch serve';

// What to do without an app token depends on who started the running daemon:
// a background one (ensureDaemon) printed its token to /dev/null on purpose,
// since agents read that output, so only a replacement can show one.
export function noAppTokenMessage(
  command: string,
  daemon?: Pick<DaemonConnection, 'pid' | 'port' | 'background' | 'startedBy'>
): string {
  const lead =
    `${command} needs the daemon app token, which only a human holds; the ` +
    'agent token in the daemon file cannot decide. Pass --token, or set ' +
    'DISPATCH_APP_TOKEN, to the value on the DISPATCH_APP_TOKEN line ' +
    '`dispatch serve` prints at startup.';
  if (daemon === undefined) return lead;
  const which = `pid ${daemon.pid}, port ${daemon.port}`;
  const inApp = command.startsWith('dispatch team join')
    ? ' (Settings → Members → Join a team)'
    : '';
  // One line: cli.ts prints only a failure's first line.
  if (daemon.background)
    return (
      `${lead} The dispatchd serving this project (${which}) was started in ` +
      `the background by ${daemon.startedBy ?? 'a dispatch command'}, so its ` +
      'app token went nowhere, on purpose: agents read that output. Run ' +
      '`dispatch serve` in a terminal you keep open; it takes over the ' +
      'background daemon (once it has no live work) and prints a token. Or ' +
      'open the project in the Dispatch app and press Restart Dispatch from ' +
      `this app${inApp === '' ? '' : `, then use ${inApp.slice(2, -1)}`}.`
    );
  return (
    `${lead} The dispatchd serving this project (${which}) was started by ` +
    'the Dispatch app or by `dispatch serve`, which hold its token: copy it ' +
    `from that terminal, or do it in the app${inApp}. Failing both, run ` +
    '`dispatch serve --replace` in a terminal you keep open; it stops that ' +
    'daemon once it has no live work, takes over and prints a token.'
  );
}

// Invites and daemon tokens are both long opaque strings; this catches one in
// the wrong place without ever echoing it. Mirrors server's looksLikeInvite.
function looksLikeInvite(value: string): boolean {
  return (
    value.startsWith('dispatch-team:') ||
    value.startsWith('https://dispatch.foo/join#') ||
    value.startsWith('di1.')
  );
}

// Never read from a file, unlike the agent token: an app token an agent could
// read out of the daemon home is the exact hole the two-token split closes.
export function resolveAppToken(
  explicit: string | undefined,
  command: string,
  daemon?: DaemonConnection
): string {
  const value = optionalAppToken(explicit);
  if (value === undefined)
    throw new CliError(noAppTokenMessage(command, daemon));
  return value;
}

// The app token when one was given (--token first, then DISPATCH_APP_TOKEN),
// for commands that only read more with it; blank counts as none.
export function optionalAppToken(
  explicit: string | undefined
): string | undefined {
  const value = (explicit ?? process.env.DISPATCH_APP_TOKEN)?.trim();
  if (value !== undefined && looksLikeInvite(value))
    throw new CliError(
      'that is a team invite link, not a daemon token: run `dispatch team join` ' +
        'and paste it at the prompt. The app token is the DISPATCH_APP_TOKEN ' +
        'line `dispatch serve` prints at startup.'
    );
  return value === '' ? undefined : value;
}

// Attaches first, so a missing token's error can name the running daemon, and
// so a command fails here before it prompts for any secret.
export async function appTokenConnection(
  ctx: CliContext,
  token: string | undefined,
  command: string
): Promise<{ baseUrl: string; appToken: string }> {
  const { baseUrl, daemon } = await attachToRunningDaemon(ctx);
  return { baseUrl, appToken: resolveAppToken(token, command, daemon) };
}

// A client on the app token, attached to the daemon already running: what
// every decide-tier or messaging command talks through.
export async function appTokenClient(
  ctx: CliContext,
  token: string | undefined,
  command: string
): Promise<ApiClient> {
  const { baseUrl, appToken } = await appTokenConnection(ctx, token, command);
  return createApiClient(baseUrl, appToken);
}

// Attaches to a running daemon, never starting one: a daemon this command
// spawned would have minted an app token that no supplied `--token` matches.
export async function attachToRunningDaemon(
  ctx: CliContext
): Promise<{ baseUrl: string; agentToken: string; daemon: DaemonConnection }> {
  requireInitialized(ctx);
  const daemon = await findRunningDaemon(ctx.cwd);
  if (daemon === null) throw new CliError(NO_DAEMON_MESSAGE);
  return {
    baseUrl: `http://127.0.0.1:${daemon.port}`,
    agentToken: daemon.agentToken,
    daemon,
  };
}
