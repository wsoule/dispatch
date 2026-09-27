import type { ApiClient } from '../apiClient.js';
import { createApiClient } from '../apiClient.js';
import { type CliContext, CliError } from '../context.js';
import { findRunningDaemon } from './daemon.js';
import { requireInitialized } from './task.js';

const NO_DAEMON_MESSAGE =
  'no dispatchd is running for this project — start one with: dispatch serve';

// Deciding and messaging refuse the agent token, and a daemon auto-started in
// the background printed its app token to /dev/null.
function noAppTokenMessage(command: string): string {
  return (
    `${command} needs the daemon app token, which only a human holds; the ` +
    'agent token in the daemon file cannot decide or message. Pass --token, or set ' +
    'DISPATCH_APP_TOKEN, taking the value from the DISPATCH_APP_TOKEN line ' +
    '`dispatch serve` prints at startup. A daemon that another dispatch ' +
    'command auto-started in the background printed that line to /dev/null and ' +
    'cannot get it back: stop it and run `dispatch serve` instead.'
  );
}

// Never read from a file, unlike the agent token: an app token an agent could
// read out of the daemon home is the exact hole the two-token split closes.
export function resolveAppToken(
  explicit: string | undefined,
  command: string
): string {
  const value = optionalAppToken(explicit);
  if (value === undefined) throw new CliError(noAppTokenMessage(command));
  return value;
}

// The app token when one was given (--token first, then DISPATCH_APP_TOKEN),
// for commands that only read more with it; blank counts as none.
export function optionalAppToken(
  explicit: string | undefined
): string | undefined {
  const value = (explicit ?? process.env.DISPATCH_APP_TOKEN)?.trim();
  return value === '' ? undefined : value;
}

// A client on the app token, attached to the daemon already running: what
// every decide-tier or messaging command talks through.
export async function appTokenClient(
  ctx: CliContext,
  token: string | undefined,
  command: string
): Promise<ApiClient> {
  const appToken = resolveAppToken(token, command);
  const { baseUrl } = await attachToRunningDaemon(ctx);
  return createApiClient(baseUrl, appToken);
}

// Attaches to a running daemon, never starting one: a daemon this command
// spawned would have minted an app token that no supplied `--token` matches.
export async function attachToRunningDaemon(
  ctx: CliContext
): Promise<{ baseUrl: string; agentToken: string }> {
  requireInitialized(ctx);
  const daemon = await findRunningDaemon(ctx.cwd);
  if (daemon === null) throw new CliError(NO_DAEMON_MESSAGE);
  return {
    baseUrl: `http://127.0.0.1:${daemon.port}`,
    agentToken: daemon.agentToken,
  };
}
