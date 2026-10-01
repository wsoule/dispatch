import type { StandaloneOptions } from '@dispatch/a2a';
import { checkStandalone } from '@dispatch/a2a';
import { lstatSync, readFileSync } from 'node:fs';

import { type CliContext, CliError } from '../context.js';
import { attachToRunningDaemon } from './appToken.js';

export interface ServeCommandOptions {
  port?: string;
  host?: string;
  public?: boolean;
  publicUrl?: string;
  tlsCert?: string;
  tlsKey?: string;
  daemon?: string;
  hostTokenFile?: string;
  trustForwardedFor?: boolean;
}

// The host token, from a regular file the current user owns and alone can
// read, or the environment; never argv, and never quoted in an error.
function readHostToken(file: string | undefined): string {
  if (file !== undefined) {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(file);
    } catch {
      throw new CliError(`cannot read the host token file ${file}`);
    }
    if (!st.isFile())
      throw new CliError(
        `the host token file ${file} must be a regular file, not a symlink or directory`
      );
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid)
      throw new CliError(
        `the host token file ${file} is not owned by the current user`
      );
    if ((Number(st.mode) & 0o077) !== 0)
      throw new CliError(
        `the host token file ${file} is readable by others; run chmod 600 on it`
      );
    return readFileSync(file, 'utf8').trim();
  }
  return (process.env.DISPATCH_A2A_HOST_TOKEN ?? '').trim();
}

// `dispatch a2a serve` flags as StandaloneOptions: the daemon from --daemon or
// this project's daemon file, the host token from a 0600 file or the
// environment (spec:1668-1707). Loopback unless --public says otherwise.
export async function resolveServe(
  ctx: CliContext,
  o: ServeCommandOptions
): Promise<StandaloneOptions> {
  if (o.port === undefined)
    throw new CliError(
      'dispatch a2a serve needs --port (the card needs a stable port)'
    );
  if ((o.tlsCert === undefined) !== (o.tlsKey === undefined))
    throw new CliError('--tls-cert and --tls-key go together');
  const hostToken = readHostToken(o.hostTokenFile);
  if (hostToken === '')
    throw new CliError(
      'dispatch a2a serve needs a host token: --host-token-file <file> or DISPATCH_A2A_HOST_TOKEN (mint one with: dispatch a2a hosts add <name> --public-url <url>)'
    );
  const daemonUrl = (
    o.daemon ?? (await attachToRunningDaemon(ctx)).baseUrl
  ).replace(/\/$/, '');
  const options: StandaloneOptions = {
    host: o.host ?? '127.0.0.1',
    port: Number(o.port),
    publicUrl: o.publicUrl ?? null,
    tls:
      o.tlsCert === undefined || o.tlsKey === undefined
        ? null
        : {
            cert: readFileSync(o.tlsCert, 'utf8'),
            key: readFileSync(o.tlsKey, 'utf8'),
          },
    publicBind: o.public === true,
    trustForwardedFor: o.trustForwardedFor === true,
    daemonUrl,
    hostToken,
  };
  const checked = checkStandalone(options);
  if (!checked.ok) throw new CliError(`${checked.key}: ${checked.error}`);
  return options;
}
