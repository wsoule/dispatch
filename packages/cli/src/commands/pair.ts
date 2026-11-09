import type { Command } from 'commander';

import type { PairingOffer, TeamTier } from '../apiClient.js';
import type { CliContext } from '../context.js';
import { CliError } from '../context.js';
import { formatTable } from '../output.js';
import { appTokenClient, attachToRunningDaemon } from './appToken.js';

/**
 * `dispatch pair` — connects another of your own devices (the Dispatch app on
 * another machine, a phone) to the daemon running here.
 *
 * Run on the daemon's machine, it prints a one-time code; the other device
 * enters it with the daemon's URL and gets a token of its own, which speaks
 * for you at the tier chosen here. See packages/server/src/devices.ts.
 */

const TIERS: readonly TeamTier[] = ['request', 'decide', 'operator'];

function tierFrom(value: string | undefined): TeamTier {
  const tier = value ?? 'operator';
  if (!(TIERS as readonly string[]).includes(tier)) {
    throw new CliError(
      `unknown tier "${tier}": use request, decide or operator`
    );
  }
  return tier as TeamTier;
}

/** The `dispatch://pair` link the app opens; formatPairingLink in
 *  packages/client/src/api.ts reads the same shape. */
function pairingLink(baseUrl: string, code: string): string {
  return `dispatch://pair?url=${encodeURIComponent(baseUrl)}&code=${encodeURIComponent(code)}`;
}

/**
 * What `dispatch pair` prints for an offer: the code, then how the other
 * device reaches this daemon. A daemon on the network is reached at its own
 * https origins. A loopback-only one is reached over an SSH forward — and
 * only that: a tunnel such as `tailscale serve` or cloudflared also arrives
 * as loopback, where the daemon trusts the request and serves its agent
 * token in the page, so it must not be used to expose this port.
 */
export function describeOffer(offer: PairingOffer, port: number): string[] {
  const until = new Date(offer.expiresAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const lines = [
    `Pairing code: ${offer.code}  (${offer.tier} tier, works once, until ${until})`,
    '',
  ];
  const https = offer.origins.filter((o) => o.startsWith('https://'));
  if (https.length > 0) {
    lines.push(
      'On the other device: Connect to a remote dispatchd, then enter one of these URLs and the code — or open the link:'
    );
    for (const origin of https) {
      lines.push(`  ${origin}`, `  ${pairingLink(origin, offer.code)}`);
    }
    return lines;
  }
  if (offer.shared) {
    lines.push(
      'This daemon listens on the network without TLS, and the app will not send a token over plain http to another machine.',
      'Restart it with --tls-cert/--tls-key (`dispatch serve --host 0.0.0.0 --tls-cert … --tls-key …`), or use an SSH forward as below.',
      ''
    );
  }
  const local = `http://127.0.0.1:${port}`;
  lines.push(
    'This daemon is reachable on this machine only. From the other machine, forward it over SSH and keep that running:',
    `  ssh -N -L 127.0.0.1:${port}:127.0.0.1:${port} <this machine>`,
    '  (or `dispatch remote forward <name> ' +
      String(port) +
      '` from a project that lists this machine)',
    `then connect to ${local} with the code, or open:`,
    `  ${pairingLink(local, offer.code)}`,
    '',
    'Do not expose this port with tailscale serve, cloudflared or a reverse proxy: they reach the daemon as loopback, which it trusts. Use --host 0.0.0.0 with TLS instead.'
  );
  return lines;
}

function day(iso: string | null): string {
  return iso === null ? '-' : iso.slice(0, 10);
}

export function registerPairCommands(program: Command, ctx: CliContext): void {
  const pair = program
    .command('pair')
    .description(
      'Pair another of your devices (the app on another machine, a phone) with this daemon'
    )
    .option(
      '--tier <tier>',
      'what the device may do: request, decide or operator (default: operator)'
    )
    .option('--token <token>', 'the daemon app token (or DISPATCH_APP_TOKEN)')
    .option('--json')
    .action(async (opts: { tier?: string; token?: string; json?: boolean }) => {
      const tier = tierFrom(opts.tier);
      const { daemon } = await attachToRunningDaemon(ctx);
      const client = await appTokenClient(ctx, opts.token, 'dispatch pair');
      const offer = await client.offerPairing({ tier });
      if (opts.json === true) {
        ctx.log(JSON.stringify(offer, null, 2));
        return;
      }
      for (const line of describeOffer(offer, daemon.port)) ctx.log(line);
    });

  pair
    .command('list')
    .description('Every paired device (never its token)')
    .option('--token <token>', 'the daemon app token (or DISPATCH_APP_TOKEN)')
    .option('--json')
    .action(async (opts: { token?: string; json?: boolean }) => {
      const client = await appTokenClient(
        ctx,
        opts.token,
        'dispatch pair list'
      );
      const devices = await client.listDevices();
      if (opts.json === true) {
        ctx.log(JSON.stringify(devices, null, 2));
        return;
      }
      if (devices.length === 0) {
        ctx.log('No paired devices. Pair one with: dispatch pair');
        return;
      }
      ctx.log(
        formatTable([
          ['ID', 'NAME', 'TIER', 'PAIRED', 'LAST USED'],
          ...devices.map((d) => [
            d.id,
            d.name,
            d.tier,
            day(d.pairedAt),
            day(d.lastUsedAt),
          ]),
        ])
      );
    });

  pair
    .command('revoke <id>')
    .description(
      'Unpair a device, and any device it paired; its token stops at once'
    )
    .option('--token <token>', 'the daemon app token (or DISPATCH_APP_TOKEN)')
    .action(async (id: string, opts: { token?: string }) => {
      const client = await appTokenClient(
        ctx,
        opts.token,
        'dispatch pair revoke'
      );
      await client.revokeDevice(id);
      ctx.log(`Unpaired ${id}.`);
    });
}
