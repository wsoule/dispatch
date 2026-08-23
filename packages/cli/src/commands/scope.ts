import type { Command } from 'commander';

import { createApiClient } from '../apiClient.js';
import { type CliContext, CliError } from '../context.js';
import { findRunningDaemon } from './daemon.js';
import { requireInitialized } from './task.js';

const NO_DAEMON_MESSAGE =
  'no dispatchd is running for this project — start one with: dispatch serve';

// Deciding a scope request needs the app token, which the daemon prints once
// on stdout and never writes down. A daemon started in the background by any
// other `dispatch` command sends that line to /dev/null, so its app token is
// gone for the life of the process — hence the second sentence.
const NO_APP_TOKEN_MESSAGE =
  'dispatch scope decide needs the daemon app token: pass --token, or set ' +
  'DISPATCH_APP_TOKEN, taking the value from the DISPATCH_APP_TOKEN line ' +
  '`dispatch serve` prints at startup. A daemon that another dispatch ' +
  'command auto-started in the background printed that line to /dev/null and ' +
  'cannot get it back: stop it and run `dispatch serve` instead.';

// Never read from a file, unlike the agent token: an app token an agent could
// read out of the daemon home is the exact hole the two-token split closes.
function resolveAppToken(explicit: string | undefined): string {
  const value = explicit ?? process.env.DISPATCH_APP_TOKEN;
  if (value === undefined || value.trim() === '') {
    throw new CliError(NO_APP_TOKEN_MESSAGE);
  }
  return value.trim();
}

// Attaches to a running daemon, never starting one: a daemon this command
// spawned would have minted an app token that no supplied `--token` matches.
async function attach(
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

export function registerScopeCommands(program: Command, ctx: CliContext): void {
  const scope = program
    .command('scope')
    .description("Inspect and decide an agent's out-of-fence edit requests");

  scope
    .command('show <runId> <requestId>')
    .description('Show one scope request and whether it has been decided')
    .option('--json')
    .action(
      async (runId: string, requestId: string, opts: { json?: boolean }) => {
        const { baseUrl, agentToken } = await attach(ctx);
        const client = createApiClient(baseUrl, agentToken);
        const request = await client.getScopeRequest(runId, requestId);
        if (opts.json === true) {
          ctx.log(JSON.stringify(request, null, 2));
          return;
        }
        const state =
          request.granted === null
            ? 'pending'
            : request.granted
              ? 'granted'
              : 'denied';
        ctx.log(`${request.id}  run=${request.runId}  ${state}`);
        ctx.log(`paths: ${request.paths.join(', ')}`);
        ctx.log(`reason: ${request.reason}`);
        if (request.decisionReason !== null) {
          ctx.log(`decision: ${request.decisionReason}`);
        }
      }
    );

  scope
    .command('decide <runId> <requestId>')
    .description('Grant or deny a scope request (needs the daemon app token)')
    .option('--deny', 'deny the request instead of granting it')
    .option('--reason <text>', 'what to record as the justification')
    .option('--token <token>', 'the daemon app token (or DISPATCH_APP_TOKEN)')
    .action(
      async (
        runId: string,
        requestId: string,
        opts: { deny?: boolean; reason?: string; token?: string }
      ) => {
        const appToken = resolveAppToken(opts.token);
        const { baseUrl } = await attach(ctx);
        const granted = opts.deny !== true;
        const reason =
          opts.reason ?? (granted ? 'granted at the CLI' : 'denied at the CLI');
        // A client of its own, built on the app token: nothing else this CLI
        // does gets to carry a decide-tier credential.
        const decided = await createApiClient(
          baseUrl,
          appToken
        ).decideScopeRequest(runId, requestId, granted, reason);
        ctx.log(
          `${decided.id} ${granted ? 'granted' : 'denied'} (${decided.paths.join(', ')})`
        );
      }
    );
}
