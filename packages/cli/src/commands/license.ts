import type { Command } from 'commander';

import type { LicenseStatus } from '../apiClient.js';
import { createApiClient } from '../apiClient.js';
import type { CliContext } from '../context.js';
import { appTokenClient, attachToRunningDaemon } from './appToken.js';

/** The plan as a person reads it: who it covers and how full it is. */
export function describeLicense(status: LicenseStatus): string[] {
  const plan =
    status.kind === 'licensed'
      ? `Licensed to ${status.org ?? 'unknown'} for ${status.seats} people${
          status.expiresAt === null
            ? ''
            : `, until ${status.expiresAt.slice(0, 10)}`
        }.`
      : `Free plan: up to ${status.seats} people.`;
  const lines = [plan, `${status.used} of ${status.seats} seats in use.`];
  if (status.kind === 'expired') {
    lines.push(
      `The license for ${status.org ?? 'unknown'} expired on ${status.expiresAt?.slice(0, 10) ?? 'an unknown date'}; the free plan applies until a new key is installed.`
    );
  }
  if (status.kind === 'invalid' && status.reason !== null) {
    lines.push(`The installed key was not accepted: ${status.reason}.`);
  }
  return lines;
}

export function registerLicenseCommands(
  program: Command,
  ctx: CliContext
): void {
  const license = program
    .command('license')
    .description(
      'Show how many people may use Dispatch together here, or install a license key'
    )
    .option('--json')
    .action(async (opts: { json?: boolean }) => {
      const { baseUrl, agentToken } = await attachToRunningDaemon(ctx);
      const status = await createApiClient(baseUrl, agentToken).getLicense();
      if (opts.json === true) ctx.log(JSON.stringify(status, null, 2));
      else for (const line of describeLicense(status)) ctx.log(line);
    });

  license
    .command('set <key>')
    .description(
      'Install a license key on this machine (needs the app token: --token or DISPATCH_APP_TOKEN)'
    )
    .option('--token <appToken>', 'the app token (default: DISPATCH_APP_TOKEN)')
    .action(async (key: string, opts: { token?: string }) => {
      const client = await appTokenClient(
        ctx,
        opts.token,
        'dispatch license set'
      );
      const status = await client.installLicense(key);
      for (const line of describeLicense(status)) ctx.log(line);
    });
}
