import type { Command } from 'commander';
import { resolve } from 'node:path';

import type {
  A2AApiClient,
  A2AClientSummary,
  A2AListenerStatus,
} from '../apiClient.js';
import { createA2AApiClient } from '../apiClient.js';
import { type CliContext, CliError } from '../context.js';
import { formatTable } from '../output.js';
import { attachToRunningDaemon, resolveAppToken } from './appToken.js';

const TOKEN_HELP = 'the daemon app token (or DISPATCH_APP_TOKEN)';

interface ListenOptions {
  host?: string;
  port?: string;
  publicUrl?: string;
  tlsCert?: string;
  tlsKey?: string;
  trustForwardedFor?: boolean;
  standalone?: boolean;
  off?: boolean;
  status?: boolean;
  token?: string;
}

// The one client a name picks out: its address, its `a2a.` name, or the name
// as typed; several matches (two owners' clients) need the address instead.
function clientNamed(clients: A2AClientSummary[], arg: string): string {
  const matches = clients.filter(
    (c) => c.address === arg || c.name === arg || c.name === `a2a.${arg}`
  );
  if (matches.length === 0) throw new CliError(`no A2A client ${arg}`);
  if (matches.length > 1) {
    throw new CliError(
      `${arg} names more than one client (${matches.map((c) => c.address).join(', ')}); pass its address`
    );
  }
  return matches[0].address;
}

function printToken(ctx: CliContext, token: string): void {
  ctx.log(`token: ${token}`);
  ctx.log(
    "This token is shown once. Give it to the client's operator; it goes in Authorization: Bearer on the A2A listener, never on /api."
  );
}

// dispatch a2a: expose this project as an A2A agent and manage who may call it.
export function registerA2ACommands(program: Command, ctx: CliContext): void {
  const a2a = program
    .command('a2a')
    .description(
      'Expose this project as an A2A agent: the listener, its card, clients and their tasks'
    );

  const withAgentToken = async (): Promise<A2AApiClient> => {
    const { baseUrl, agentToken } = await attachToRunningDaemon(ctx);
    return createA2AApiClient(baseUrl, agentToken);
  };
  // Resolves the app token before attaching, so a missing one sends nothing.
  const withAppToken = async (
    explicit: string | undefined,
    command: string
  ): Promise<A2AApiClient> => {
    const appToken = resolveAppToken(explicit, command);
    const { baseUrl } = await attachToRunningDaemon(ctx);
    return createA2AApiClient(baseUrl, appToken);
  };
  const printStatus = (s: A2AListenerStatus): void => {
    ctx.log(
      s.listening
        ? `A2A listener: listening at ${s.url ?? ''}`
        : `A2A listener: closed${s.error === null ? '' : ` (${s.error})`}`
    );
    for (const w of s.warnings) ctx.log(`warning: ${w}`);
    for (const a of s.legacyClients) {
      ctx.log(
        `warning: ${a} is an a2a.* agent with no clients row; revoke it, then add a new client with dispatch a2a clients add`
      );
    }
  };

  a2a
    .command('listen')
    .description(
      'Open, show or close the opt-in A2A listener (changing it needs the daemon app token)'
    )
    .option(
      '--host <addr>',
      '127.0.0.1 (default) or 0.0.0.0 (needs --tls-cert/--tls-key)'
    )
    .option('--port <n>', "the listener port; never the daemon's own")
    .option(
      '--public-url <url>',
      'what the card advertises (https unless loopback)'
    )
    .option('--tls-cert <file>', 'serve the listener over HTTPS (PEM)')
    .option('--tls-key <file>', 'the private key for --tls-cert')
    .option(
      '--trust-forwarded-for',
      'behind a tunnel on loopback: key per-IP limits on X-Forwarded-For'
    )
    .option('--standalone', 'enable /api/a2a/port/* for `dispatch a2a serve`')
    .option('--off', 'close the listener')
    .option('--status', 'show whether and where it listens')
    .option('--token <token>', TOKEN_HELP)
    .action(async (o: ListenOptions) => {
      if (o.status === true) {
        printStatus(await (await withAgentToken()).listenerStatus());
        return;
      }
      if (o.off === true) {
        const client = await withAppToken(o.token, 'dispatch a2a listen --off');
        printStatus(await client.disableListener());
        return;
      }
      if (o.port === undefined) {
        throw new CliError(
          'dispatch a2a listen needs --port (a card URL needs a stable port)'
        );
      }
      const port = Number(o.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new CliError(`--port must be 1-65535, not ${o.port}`);
      }
      if ((o.tlsCert === undefined) !== (o.tlsKey === undefined)) {
        throw new CliError('--tls-cert and --tls-key go together');
      }
      const client = await withAppToken(o.token, 'dispatch a2a listen');
      printStatus(
        await client.setListener({
          enabled: true,
          host: o.host ?? '127.0.0.1',
          port,
          publicUrl: o.publicUrl ?? null,
          tls:
            o.tlsCert === undefined || o.tlsKey === undefined
              ? null
              : {
                  certPath: resolve(ctx.cwd, o.tlsCert),
                  keyPath: resolve(ctx.cwd, o.tlsKey),
                },
          trustForwardedFor: o.trustForwardedFor === true,
          standalone: o.standalone === true,
        })
      );
    });

  a2a
    .command('card')
    .description('Print the agent card the listener serves')
    .action(async () => {
      const card = await (await withAgentToken()).card();
      ctx.log(JSON.stringify(card, null, 2));
    });

  const clients = a2a
    .command('clients')
    .description('The A2A clients that may call this project');

  clients
    .command('add <name>')
    .description(
      'Register a client and print its token once (--approve needs the daemon app token)'
    )
    .option(
      '--to <address>',
      'a human:<handle> the client may address besides the owner (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[]
    )
    .option('--approve', 'approve its registration at once')
    .option('--token <token>', `with --approve: ${TOKEN_HELP}`)
    .action(
      async (
        name: string,
        o: { to: string[]; approve?: boolean; token?: string }
      ) => {
        const client =
          o.approve === true
            ? await withAppToken(o.token, 'dispatch a2a clients add --approve')
            : await withAgentToken();
        const added = await client.addClient({
          name,
          ...(o.to.length > 0 ? { to: o.to } : {}),
          ...(o.approve === true ? { approve: true } : {}),
        });
        ctx.log(`${added.address}  ${added.status}`);
        if (added.status === 'pending') {
          ctx.log(
            'It can call the listener once its registration is approved in Needs you.'
          );
        }
        printToken(ctx, added.token);
      }
    );

  clients
    .command('list')
    .description('List the A2A clients and who each may address')
    .action(async () => {
      const { clients: rows } = await (await withAgentToken()).clients();
      ctx.log(
        rows.length === 0
          ? '(none)'
          : formatTable([
              ['NAME', 'ADDRESS', 'STATUS', 'RECIPIENTS'],
              ...rows.map((c) => [
                c.name,
                c.address,
                c.status,
                c.recipients.join(', '),
              ]),
            ])
      );
    });

  clients
    .command('rotate <name>')
    .description(
      'Replace a client token; the old one stops working at once (needs the daemon app token)'
    )
    .option('--token <token>', TOKEN_HELP)
    .action(async (name: string, o: { token?: string }) => {
      const client = await withAppToken(o.token, 'dispatch a2a clients rotate');
      const { token } = await client.rotateClient(name);
      printToken(ctx, token);
    });

  clients
    .command('revoke <name>')
    .description(
      'End a client: its token stops working and its open asks close (needs the daemon app token)'
    )
    .option('--token <token>', TOKEN_HELP)
    .action(async (name: string, o: { token?: string }) => {
      const client = await withAppToken(o.token, 'dispatch a2a clients revoke');
      const address = clientNamed((await client.clients()).clients, name);
      await client.revokeAgent(address);
      ctx.log(`revoked ${address}`);
    });

  const tasks = a2a
    .command('tasks')
    .description(
      "A2A clients' tasks, newest first (needs the daemon app token)"
    );

  tasks
    .command('list', { isDefault: true })
    .description('List A2A tasks, newest first')
    .option('--client <name>', 'only this client')
    .option('--token <token>', TOKEN_HELP)
    .action(async (o: { client?: string; token?: string }) => {
      const client = await withAppToken(o.token, 'dispatch a2a tasks');
      const { tasks: rows } = await client.tasks(o.client);
      ctx.log(
        rows.length === 0
          ? '(none)'
          : formatTable([
              ['ID', 'SKILL', 'STATE', 'CLIENT', 'STATUS AT', 'TASK'],
              ...rows.map((t) => [
                t.id,
                t.skill,
                t.state,
                t.client,
                t.statusAt,
                t.dispatchTask ?? '-',
              ]),
            ])
      );
    });

  tasks
    .command('decline <id>')
    .description(
      'Decline an unanswered ask; the client sees it rejected with the reason'
    )
    .option('--reason <text>', 'why, shown to the client')
    .option('--token <token>', TOKEN_HELP)
    .action(async (id: string, o: { reason?: string; token?: string }) => {
      const client = await withAppToken(o.token, 'dispatch a2a tasks decline');
      await client.declineTask(id, o.reason);
      ctx.log(`declined ${id}`);
    });
}
