import type { Command } from 'commander';

import type { ApiClient, Message } from '../apiClient.js';
import { type CliContext, CliError } from '../context.js';
import { appTokenClient } from './appToken.js';

interface ScopeGate {
  message: Message;
  paths: string[];
  reason: string;
}

// Reads a scope gate a run raised; any other message is a CliError, so
// `decide` never answers a question it was not meant for.
async function readScopeGate(
  client: ApiClient,
  messageId: string
): Promise<ScopeGate> {
  const message = await client.getMessage(messageId);
  const data = message.data as
    | { type?: unknown; paths?: unknown; reason?: unknown }
    | null
    | undefined;
  if (
    data?.type !== 'scope' ||
    !Array.isArray(data.paths) ||
    typeof data.reason !== 'string'
  ) {
    throw new CliError(`${messageId} is not a scope request`);
  }
  return { message, paths: data.paths as string[], reason: data.reason };
}

export function registerScopeCommands(program: Command, ctx: CliContext): void {
  const scope = program
    .command('scope')
    .description("Inspect and decide an agent's out-of-fence edit requests");

  scope
    .command('show <messageId>')
    .description(
      'Show one scope request and whether it has been decided (needs the daemon app token)'
    )
    .option('--json')
    .option('--token <token>', 'the daemon app token (or DISPATCH_APP_TOKEN)')
    .action(
      async (messageId: string, opts: { json?: boolean; token?: string }) => {
        const client = await appTokenClient(
          ctx,
          opts.token,
          'dispatch scope show'
        );
        const gate = await readScopeGate(client, messageId);
        const { answer } = await client.getAnswer(messageId);
        if (opts.json === true) {
          ctx.log(JSON.stringify({ message: gate.message, answer }, null, 2));
          return;
        }
        // An expiry or a closed gate answers without `grant`, so it reads as denied.
        const state =
          answer === null
            ? 'pending'
            : answer.choice === 'grant'
              ? 'granted'
              : 'denied';
        const from = gate.message.from;
        const run = from.startsWith('run:') ? from.slice('run:'.length) : from;
        ctx.log(`${messageId}  run=${run}  ${state}`);
        ctx.log(`paths: ${gate.paths.join(', ')}`);
        ctx.log(`reason: ${gate.reason}`);
        if (answer !== null && answer.body.trim() !== '') {
          ctx.log(`decision: ${answer.body}`);
        }
      }
    );

  scope
    .command('decide <messageId>')
    .description('Grant or deny a scope request (needs the daemon app token)')
    .option('--deny', 'deny the request instead of granting it')
    .option('--reason <text>', 'what to record as the justification')
    .option('--token <token>', 'the daemon app token (or DISPATCH_APP_TOKEN)')
    .action(
      async (
        messageId: string,
        opts: { deny?: boolean; reason?: string; token?: string }
      ) => {
        const client = await appTokenClient(
          ctx,
          opts.token,
          'dispatch scope decide'
        );
        const gate = await readScopeGate(client, messageId);
        const granted = opts.deny !== true;
        const reason =
          opts.reason ?? (granted ? 'granted at the CLI' : 'denied at the CLI');
        await client.replyToMessage(messageId, {
          body: reason,
          choice: granted ? 'grant' : 'deny',
        });
        ctx.log(
          `${messageId} ${granted ? 'granted' : 'denied'} (${gate.paths.join(', ')})`
        );
      }
    );
}
