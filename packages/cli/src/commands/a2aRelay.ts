import type { RelayOptions } from '@dispatch-foo/a2a';
import { readFileSync } from 'node:fs';

import { CliError } from '../context.js';

export interface RelayCommandOptions {
  port?: string;
  host?: string;
  public?: boolean;
  publicUrl?: string;
  tlsCert?: string;
  tlsKey?: string;
  tenantsFile?: string;
  trustForwardedFor?: boolean;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

// `dispatch a2a relay` flags as RelayOptions. The relay itself re-checks the
// bind rules and reads the 0600 tenants file when it starts.
export function resolveRelay(
  o: RelayCommandOptions
): Omit<RelayOptions, 'log'> {
  if (o.port === undefined)
    throw new CliError('dispatch a2a relay needs --port');
  if (o.tenantsFile === undefined)
    throw new CliError(
      'dispatch a2a relay needs --tenants-file: a 0600 file of the card-key thumbprints it admits, one per line'
    );
  if ((o.tlsCert === undefined) !== (o.tlsKey === undefined))
    throw new CliError('--tls-cert and --tls-key go together');
  const host = o.host ?? '127.0.0.1';
  if (!LOOPBACK.has(host) && o.public !== true)
    throw new CliError('binding every network interface needs --public');
  const port = Number(o.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new CliError('--port takes 1-65535');
  return {
    host,
    port,
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
    tenantsFile: o.tenantsFile,
  };
}
