import type { Command } from 'commander';
import { renderUnicodeCompact } from 'uqr';

import type { RemoteAccessStatus } from '../apiClient.js';
import type { CliContext } from '../context.js';
import { appTokenClient } from './appToken.js';

/**
 * `dispatch phone` — pair the Dispatch iOS app with this project's daemon.
 *
 * The phone reaches the daemon through the remote relay, with no VPN and no
 * open port: both ends dial out and everything between them is end-to-end
 * encrypted. Pairing shows a QR code holding a one-time code that works for
 * ten minutes. A paired phone acts for you at the decide tier: it answers
 * approvals and questions, cancels runs and approves merges, and can do
 * nothing that needs the app token.
 */

/** The devices list as a person reads it. */
export function describePhones(status: RemoteAccessStatus): string[] {
  if (!status.enabled)
    return ['Remote access is off on this daemon (DISPATCH_REMOTE=off).'];
  if (status.devices.length === 0)
    return ['No phone is paired. Pair one with: dispatch phone pair'];
  const link =
    status.link.kind === 'connected'
      ? 'reachable through the relay'
      : status.link.kind === 'error'
        ? `not reachable: ${status.link.message}`
        : 'connecting to the relay';
  return [
    `${status.devices.length === 1 ? '1 phone' : `${status.devices.length} phones`} paired, ${link}:`,
    ...status.devices.map(
      (d) =>
        `  ${d.id}  ${d.name}  paired ${d.pairedAt.slice(0, 10)}${
          d.lastSeenAt === null
            ? ''
            : `, last seen ${d.lastSeenAt.slice(0, 16).replace('T', ' ')}`
        }`
    ),
  ];
}

export function registerPhoneCommands(program: Command, ctx: CliContext): void {
  const phone = program
    .command('phone')
    .description(
      'Pair the Dispatch iOS app with this project, or list and unpair phones (needs the app token)'
    );

  phone
    .command('pair')
    .description('Show a QR code to scan with the Dispatch iOS app')
    .option('--token <appToken>', 'the app token (default: DISPATCH_APP_TOKEN)')
    .option('--url', 'print the pairing link instead of a QR code')
    .action(async (opts: { token?: string; url?: boolean }) => {
      const client = await appTokenClient(
        ctx,
        opts.token,
        'dispatch phone pair'
      );
      const offer = await client.pairPhone();
      if (opts.url === true) {
        ctx.log(offer.url);
        return;
      }
      ctx.log('Scan this with the Dispatch app on your iPhone:');
      ctx.log('');
      ctx.log(renderUnicodeCompact(offer.url, { border: 2 }));
      ctx.log('');
      ctx.log(
        `It works once, until ${new Date(offer.expiresAt).toLocaleTimeString()}. Anyone who scans it first gets in, so keep it to yourself.`
      );
    });

  phone
    .command('list')
    .description('List paired phones')
    .option('--token <appToken>', 'the app token (default: DISPATCH_APP_TOKEN)')
    .option('--json')
    .action(async (opts: { token?: string; json?: boolean }) => {
      const client = await appTokenClient(
        ctx,
        opts.token,
        'dispatch phone list'
      );
      const status = await client.getRemoteAccess();
      if (opts.json === true) ctx.log(JSON.stringify(status, null, 2));
      else for (const line of describePhones(status)) ctx.log(line);
    });

  phone
    .command('unpair <id>')
    .description('Unpair a phone; it is cut off at once')
    .option('--token <appToken>', 'the app token (default: DISPATCH_APP_TOKEN)')
    .action(async (id: string, opts: { token?: string }) => {
      const client = await appTokenClient(
        ctx,
        opts.token,
        'dispatch phone unpair'
      );
      await client.unpairPhone(id);
      ctx.log(`Unpaired ${id}.`);
    });
}
