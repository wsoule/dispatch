import { startRelay, startStandalone } from '@dispatch/a2a';
import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type {
  A2AApiClient,
  A2AClientSummary,
  A2AListenerStatus,
  A2APeerSummary,
} from '../apiClient.js';
import { createA2AApiClient } from '../apiClient.js';
import { type CliContext, CliError } from '../context.js';
import { formatTable } from '../output.js';
import type { RelayCommandOptions } from './a2aRelay.js';
import { resolveRelay } from './a2aRelay.js';
import type { ServeCommandOptions } from './a2aServe.js';
import { resolveServe, stopSignal } from './a2aServe.js';
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

// A typed name as `clients add` stores it; mirrors @dispatch/a2a's clientNameFor.
function clientNameFor(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 36);
  return `a2a.${normalized}`;
}

// The one client a name picks out: its address, its `a2a.` name, or the name
// as typed; several matches (two owners' clients) need the address instead.
function clientNamed(clients: A2AClientSummary[], arg: string): string {
  const name = clientNameFor(arg);
  const matches = clients.filter(
    (c) => c.address === arg || c.name === arg || c.name === name
  );
  if (matches.length === 0) throw new CliError(`no A2A client ${arg}`);
  if (matches.length > 1) {
    throw new CliError(
      `${arg} names more than one client (${matches.map((c) => c.address).join(', ')}); pass its address`
    );
  }
  return matches[0].address;
}

// Reads all of stdin; refuses a terminal, where nothing was piped in.
function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY === true)
    return Promise.reject(
      new CliError('this reads from a pipe; stdin is a terminal')
    );
  return Promise.resolve(readFileSync(0, 'utf8'));
}

// A peer credential only ever comes from stdin, so it never lands in shell history.
async function tokenFromStdin(ctx: CliContext): Promise<string> {
  const raw = await (ctx.readStdin ?? readAllStdin)();
  const token = raw.trim();
  if (token === '')
    throw new CliError(
      '--token-stdin read nothing: pipe the peer credential in, e.g. `pbpaste | dispatch a2a peers add …`'
    );
  return token;
}

function printPeer(ctx: CliContext, p: A2APeerSummary): void {
  ctx.log(`a2a:${p.alias} · ${p.status} · ${p.name} · ${p.interfaceUrl}`);
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
      'A2A for this project: the listener, its card, clients and their tasks, outbound peers, pairing and keys, standalone hosts (hosts, serve), and the relay'
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
    .option(
      '--no-standalone',
      'close /api/a2a/port/* (left out, the current setting stays)'
    )
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
      const status = await client.setListener({
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
        ...(o.standalone === undefined ? {} : { standalone: o.standalone }),
      });
      printStatus(status);
      // Saved but closed (port in use, bad certificate): exit non-zero for scripts.
      if (!status.listening)
        throw new CliError('the A2A listener did not open');
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

  const peers = a2a
    .command('peers')
    .description(
      'Outbound A2A peers: agents this project may message as a2a:<alias>'
    );

  peers
    .command('list', { isDefault: true })
    .description('List peers')
    .action(async () => {
      const { peers: list } = await (await withAgentToken()).peers();
      if (list.length === 0)
        ctx.log(
          'No A2A peers. Add one with: dispatch a2a peers add <alias> <card-url> --token-stdin'
        );
      for (const p of list) printPeer(ctx, p);
    });

  peers
    .command('add <alias> <cardUrl>')
    .description(
      'Register a peer from its agent card (a deciding human; private URLs, --allow-http and --allow-origin need the operator)'
    )
    .option('--token-stdin', "read the peer's credential from stdin")
    .option(
      '--api-key-header <name>',
      'send the credential in this header instead of the card’s'
    )
    .option('--allow-http', 'allow a plain-http card URL (operator)')
    .option(
      '--allow-origin',
      'allow an interface on another origin than the card (operator)'
    )
    .option('--token <token>', TOKEN_HELP)
    .action(
      async (
        alias: string,
        cardUrl: string,
        o: {
          tokenStdin?: boolean;
          apiKeyHeader?: string;
          allowHttp?: boolean;
          allowOrigin?: boolean;
          token?: string;
        }
      ) => {
        // The app token first, so a missing one fails before stdin is read.
        const client = await withAppToken(o.token, 'dispatch a2a peers add');
        const token =
          o.tokenStdin === true ? await tokenFromStdin(ctx) : undefined;
        const added = await client.addPeer({
          alias,
          cardUrl,
          ...(token === undefined ? {} : { token }),
          ...(o.apiKeyHeader === undefined
            ? {}
            : { apiKeyHeader: o.apiKeyHeader }),
          ...(o.allowHttp === true ? { allowHttp: true } : {}),
          ...(o.allowOrigin === true ? { allowOrigin: true } : {}),
        });
        printPeer(ctx, added);
      }
    );

  for (const verb of ['refresh', 'disable', 'remove'] as const) {
    peers
      .command(`${verb} <alias>`)
      .description(
        verb === 'refresh'
          ? "Re-fetch a peer's card (needs the daemon app token)"
          : verb === 'disable'
            ? 'Stop sending to a peer; its messages wait (needs the daemon app token)'
            : 'Remove a peer and its credential (needs the daemon app token)'
      )
      .option('--token <token>', TOKEN_HELP)
      .action(async (alias: string, o: { token?: string }) => {
        const client = await withAppToken(
          o.token,
          `dispatch a2a peers ${verb}`
        );
        if (verb === 'remove') {
          await client.removePeer(alias);
          ctx.log(`Removed a2a:${alias} and its credential.`);
        } else {
          printPeer(
            ctx,
            verb === 'refresh'
              ? await client.refreshPeer(alias)
              : await client.setPeerEnabled(alias, false)
          );
        }
      });
  }

  peers
    .command('enable <alias>')
    .description(
      'Send to a peer again, optionally with a new credential (needs the daemon app token)'
    )
    .option('--token-stdin', 'replace the credential from stdin')
    .option('--token <token>', TOKEN_HELP)
    .action(
      async (alias: string, o: { tokenStdin?: boolean; token?: string }) => {
        const client = await withAppToken(o.token, 'dispatch a2a peers enable');
        const token =
          o.tokenStdin === true ? await tokenFromStdin(ctx) : undefined;
        printPeer(ctx, await client.setPeerEnabled(alias, true, token));
      }
    );

  peers
    .command('upgrade <alias>')
    .description(
      'Move a bearer peer to signed requests; its owner approves the key (needs the daemon app token)'
    )
    .requiredOption(
      '--fingerprint <fp>',
      "the peer's key fingerprint, as its owner reads it to you"
    )
    .option(
      '--client <name>',
      'the A2A client the peer reaches this agent as; its approval must come over that client'
    )
    .option('--token <token>', TOKEN_HELP)
    .action(
      async (
        alias: string,
        o: { fingerprint: string; client?: string; token?: string }
      ) => {
        const client = await withAppToken(
          o.token,
          'dispatch a2a peers upgrade'
        );
        const started = await client.upgradePeer(
          alias,
          o.fingerprint,
          o.client
        );
        ctx.log(
          `a2a:${alias} (key ${started.fingerprint}) waits for its owner to approve signed requests; once they do, both sides drop the bearer.`
        );
      }
    );

  const pair = a2a
    .command('pair')
    .description(
      'Pair with another Dispatch agent by one code: signed requests both ways'
    );

  pair
    .command('offer')
    .description(
      'Make a pairing code to give the other side (needs the daemon app token)'
    )
    .requiredOption('--alias <alias>', 'what the other side is called here')
    .option('--ttl <minutes>', 'how long the code stays good, 5 to 60')
    .option('--token <token>', TOKEN_HELP)
    .action(async (o: { alias: string; ttl?: string; token?: string }) => {
      const client = await withAppToken(o.token, 'dispatch a2a pair offer');
      const ttlMin = o.ttl === undefined ? undefined : Number(o.ttl);
      if (ttlMin !== undefined && !Number.isInteger(ttlMin))
        throw new CliError('--ttl takes whole minutes, 5 to 60');
      const offered = await client.createPairing({
        alias: o.alias,
        ...(ttlMin === undefined ? {} : { ttlMin }),
      });
      ctx.log(`code: ${offered.code}`);
      ctx.log(
        `This code is shown once and is good until ${offered.expiresAt}. Give it to the other side over a channel you trust; they run dispatch a2a pair accept.`
      );
      ctx.log(`This agent's fingerprint: ${offered.fingerprint}`);
    });

  pair
    .command('accept')
    .description(
      'Accept a pairing code piped on stdin (needs the daemon app token)'
    )
    .requiredOption('--alias <alias>', 'what the other side is called here')
    .option('--token <token>', TOKEN_HELP)
    .action(async (o: { alias: string; token?: string }) => {
      // The app token first, so a missing one fails before stdin is read.
      const client = await withAppToken(o.token, 'dispatch a2a pair accept');
      const code = (await (ctx.readStdin ?? readAllStdin)()).trim();
      if (code === '')
        throw new CliError(
          'pair accept reads the code from stdin: pipe it in, e.g. `pbpaste | dispatch a2a pair accept --alias …`'
        );
      const accepted = await client.acceptPairing({ code, alias: o.alias });
      ctx.log(
        `Paired with a2a:${accepted.alias} (fingerprint ${accepted.fingerprint}).`
      );
      ctx.log(
        `SAS: ${accepted.sas}. Check the other side shows the same; if not, remove the peer.`
      );
    });

  pair
    .command('list', { isDefault: true })
    .description('Open and recent pairings (needs the daemon app token)')
    .option('--token <token>', TOKEN_HELP)
    .action(async (o: { token?: string }) => {
      const client = await withAppToken(o.token, 'dispatch a2a pair list');
      const { pairings } = await client.pairings();
      if (pairings.length === 0)
        ctx.log(
          'No pairings. Start one with: dispatch a2a pair offer --alias <alias>'
        );
      for (const p of pairings)
        ctx.log(
          `${p.id} · a2a:${p.alias} · ${p.role} · ${p.state}${p.sas === null ? '' : ` · SAS ${p.sas}`}${p.fingerprint === null ? '' : ` · ${p.fingerprint}`}`
        );
    });

  pair
    .command('cancel <id>')
    .description('Cancel an open offer (needs the daemon app token)')
    .option('--token <token>', TOKEN_HELP)
    .action(async (id: string, o: { token?: string }) => {
      const client = await withAppToken(o.token, 'dispatch a2a pair cancel');
      await client.cancelPairing(id);
      ctx.log(`Canceled pairing offer ${id}.`);
    });

  const keys = a2a
    .command('keys')
    .description("This project's card key: show it, or rotate it");

  keys
    .command('show', { isDefault: true })
    .description("The card key's fingerprint, and a rotation in its overlap")
    .action(async () => {
      const shown = await (await withAgentToken()).keys();
      ctx.log(`key: ${shown.current.fingerprint}`);
      if (shown.current.thumbprint !== undefined)
        ctx.log(
          `thumbprint: ${shown.current.thumbprint} (what a relay's tenants file lists)`
        );
      if (shown.next !== null)
        ctx.log(
          `rotating to ${shown.next.fingerprint} (since ${shown.next.since}; the old key goes ${shown.next.until})`
        );
    });

  keys
    .command('rotate')
    .description(
      'Rotate the card key; paired peers re-pin (needs the daemon app token)'
    )
    .option(
      '--compromised',
      'the key leaked: revoke it, and every pairing must be made again'
    )
    .option('--token <token>', TOKEN_HELP)
    .action(async (o: { compromised?: boolean; token?: string }) => {
      const client = await withAppToken(o.token, 'dispatch a2a keys rotate');
      const r = await client.rotateKey(o.compromised === true);
      ctx.log(`New key: ${r.fingerprint}`);
      if (r.told.length > 0)
        ctx.log(`Told: ${r.told.map((a) => `a2a:${a}`).join(', ')}`);
      if (r.untold.length > 0)
        ctx.log(
          `Not reached yet (retried): ${r.untold.map((a) => `a2a:${a}`).join(', ')}`
        );
      if (r.mustRepair.length > 0)
        ctx.log(
          `Must pair again: ${r.mustRepair.map((a) => `a2a:${a}`).join(', ')}`
        );
      if (r.overlapUntil !== null)
        ctx.log(`Both keys are served until ${r.overlapUntil}.`);
    });

  a2a
    .command('serve')
    .description(
      'Run a standalone A2A listener that reaches this daemon with a host token (a relay or hosted setup)'
    )
    .option(
      '--port <n>',
      'the listener port (required: the card needs a stable one)'
    )
    .option('--host <addr>', '127.0.0.1 (default) or a wildcard with --public')
    .option(
      '--public',
      'allow binding every network interface (needs TLS and --public-url)'
    )
    .option(
      '--public-url <url>',
      'what the card advertises (https unless loopback)'
    )
    .option('--tls-cert <file>', 'serve over HTTPS (PEM)')
    .option('--tls-key <file>', 'the private key for --tls-cert')
    .option(
      '--daemon <url>',
      "the daemon to reach (default: this project's); a remote one over https"
    )
    .option(
      '--host-token-file <file>',
      'a 0600 file holding the host token (default: DISPATCH_A2A_HOST_TOKEN)'
    )
    .option(
      '--trust-forwarded-for',
      'behind a tunnel on loopback: key per-IP limits on X-Forwarded-For'
    )
    .action(async (o: ServeCommandOptions) => {
      const standalone = await startStandalone(await resolveServe(ctx, o));
      ctx.log(
        `A2A standalone host listening at ${standalone.url} (card: ${standalone.url}/.well-known/agent-card.json). Ctrl-C or SIGTERM stops it.`
      );
      await stopSignal();
      await standalone.stop();
    });

  a2a
    .command('relay')
    .description(
      'Run an A2A relay: one public host for many daemons, each dialling in as a tenant at <public-url>/t/<thumbprint>'
    )
    .option('--port <n>', 'the port to listen on')
    .option('--host <addr>', '127.0.0.1 (default) or a wildcard with --public')
    .option(
      '--public',
      'allow binding every network interface (needs TLS and --public-url)'
    )
    .option('--public-url <url>', 'the relay origin clients and tenants use')
    .option('--tls-cert <file>', 'serve over HTTPS (PEM)')
    .option('--tls-key <file>', 'the private key for --tls-cert')
    .option(
      '--tenants-file <file>',
      'a 0600 file of admitted card-key thumbprints, one per line, an optional name after each'
    )
    .option(
      '--trust-forwarded-for',
      'behind a tunnel on loopback: key per-IP limits on X-Forwarded-For'
    )
    .action(async (o: RelayCommandOptions) => {
      let relay;
      try {
        relay = await startRelay(resolveRelay(o));
      } catch (err) {
        if (err instanceof CliError) throw err;
        throw new CliError(err instanceof Error ? err.message : String(err));
      }
      ctx.log(
        `A2A relay listening at ${relay.url}; tenants dial ${relay.url.replace(/^http/, 'ws')}/v1/tenants. Ctrl-C or SIGTERM stops it.`
      );
      await stopSignal();
      await relay.stop();
    });

  const hosts = a2a
    .command('hosts')
    .description(
      'Standalone A2A hosts allowed to reach this daemon (needs the daemon app token)'
    );
  hosts
    .command('list', { isDefault: true })
    .description('List hosts and whether standalone hosts are allowed')
    .option('--token <token>', TOKEN_HELP)
    .action(async (o: { token?: string }) => {
      const client = await withAppToken(o.token, 'dispatch a2a hosts list');
      const { standalone, hosts: list } = await client.hosts();
      ctx.log(
        `standalone hosts: ${standalone ? 'allowed' : 'not allowed (dispatch a2a hosts allow)'}`
      );
      if (list.length === 0)
        ctx.log(
          'No hosts yet. Add one with: dispatch a2a hosts add <name> --public-url <url>'
        );
      for (const h of list)
        ctx.log(
          `${h.id} · ${h.name} · ${h.publicUrl} · ${h.revokedAt === null ? 'active' : `revoked ${h.revokedAt}`} · added by ${h.createdBy}`
        );
    });
  hosts
    .command('add <name>')
    .description('Mint a host token, shown once')
    .requiredOption(
      '--public-url <url>',
      'The URL the host serves on; its card names no other'
    )
    .option('--token <token>', TOKEN_HELP)
    .action(async (name: string, o: { token?: string; publicUrl: string }) => {
      const client = await withAppToken(o.token, 'dispatch a2a hosts add');
      const added = await client.addHost(name, o.publicUrl);
      ctx.log(`${added.id} · ${added.name} · ${added.publicUrl}`);
      ctx.log(`host token: ${added.token}`);
      ctx.log(
        'This token is shown once. Put it in a chmod 600 file on the relay machine and pass --host-token-file, or set DISPATCH_A2A_HOST_TOKEN.'
      );
    });
  hosts
    .command('remove <id>')
    .description('Revoke a host token at once')
    .option('--token <token>', TOKEN_HELP)
    .action(async (id: string, o: { token?: string }) => {
      const client = await withAppToken(o.token, 'dispatch a2a hosts remove');
      await client.removeHost(id);
      ctx.log(`Revoked host ${id}.`);
    });
  for (const [verb, enabled] of [
    ['allow', true],
    ['deny', false],
  ] as const) {
    hosts
      .command(verb)
      .description(
        enabled
          ? 'Let standalone hosts reach /api/a2a/port'
          : 'Close /api/a2a/port to every standalone host'
      )
      .option('--token <token>', TOKEN_HELP)
      .action(async (o: { token?: string }) => {
        const client = await withAppToken(
          o.token,
          `dispatch a2a hosts ${verb}`
        );
        const { standalone } = await client.setStandalone(enabled);
        ctx.log(`standalone hosts: ${standalone ? 'allowed' : 'not allowed'}`);
      });
  }
}
