import { afterEach, beforeEach, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveServe } from '../src/commands/a2aServe.js';
import { CliError } from '../src/context.js';

let dir: string;
const originalToken = process.env.DISPATCH_A2A_HOST_TOKEN;
const ctx = { cwd: '/nowhere', log: () => undefined };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'a2a-serve-'));
  delete process.env.DISPATCH_A2A_HOST_TOKEN;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalToken === undefined) delete process.env.DISPATCH_A2A_HOST_TOKEN;
  else process.env.DISPATCH_A2A_HOST_TOKEN = originalToken;
});

function tokenFile(mode: number): string {
  const file = join(dir, 'host-token');
  writeFileSync(file, 'host-secret\n', { mode });
  chmodSync(file, mode);
  return file;
}

it('reads the host token from a 0600 file, binds loopback by default and reaches a remote daemon over https', async () => {
  expect(
    await resolveServe(ctx, {
      port: '7460',
      daemon: 'https://team.example.com:4443/',
      hostTokenFile: tokenFile(0o600),
    })
  ).toEqual({
    host: '127.0.0.1',
    port: 7460,
    publicUrl: null,
    tls: null,
    publicBind: false,
    trustForwardedFor: false,
    daemonUrl: 'https://team.example.com:4443',
    hostToken: 'host-secret',
  });
});

it('refuses a host token file others can read, without quoting it', async () => {
  const err = await resolveServe(ctx, {
    port: '7460',
    daemon: 'https://team.example.com',
    hostTokenFile: tokenFile(0o644),
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CliError);
  expect((err as Error).message).toContain('chmod 600');
  expect((err as Error).message).not.toContain('host-secret');
});

it.each([
  [{ daemon: 'https://team.example.com' }, /--port/],
  [{ port: '7460', daemon: 'https://team.example.com' }, /host token/],
  [
    { port: '7460', daemon: 'http://team.example.com:4000', env: true },
    /daemon/,
  ],
  [
    {
      port: '7460',
      daemon: 'https://team.example.com',
      host: '0.0.0.0',
      env: true,
    },
    /--public/,
  ],
  [
    {
      port: '7460',
      daemon: 'https://team.example.com',
      host: '0.0.0.0',
      public: true,
      env: true,
    },
    /tls/,
  ],
  [
    {
      port: '7460',
      daemon: 'https://team.example.com',
      tlsCert: 'c.pem',
      env: true,
    },
    /go together/,
  ],
])('refuses %j', async (o, message) => {
  if ((o as { env?: boolean }).env === true)
    process.env.DISPATCH_A2A_HOST_TOKEN = 'host-secret';
  await expect(resolveServe(ctx, o)).rejects.toThrow(message);
  await expect(resolveServe(ctx, o)).rejects.toBeInstanceOf(CliError);
});
