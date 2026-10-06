import { startRelay } from '@dispatch-foo/a2a';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveRelay } from '../src/commands/a2aRelay.js';
import { CliError } from '../src/context.js';
import { makeProgram } from '../src/program.js';

const TP = 'a'.repeat(43);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-a2a-relay-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function tenants(): string {
  const path = join(dir, 'tenants');
  writeFileSync(path, `${TP} alice\n`);
  chmodSync(path, 0o600);
  return path;
}

it('needs --port and --tenants-file, and TLS flags together', () => {
  expect(() => resolveRelay({ tenantsFile: tenants() })).toThrow(CliError);
  expect(() => resolveRelay({ port: '8443' })).toThrow(/--tenants-file/);
  expect(() =>
    resolveRelay({ port: '8443', tenantsFile: tenants(), tlsCert: 'c.pem' })
  ).toThrow(/go together/);
  expect(() =>
    resolveRelay({ port: '8443', tenantsFile: tenants(), host: '0.0.0.0' })
  ).toThrow(/--public/);
});

it('binds loopback by default and serves nothing but tenant paths', async () => {
  const options = resolveRelay({ port: '0', tenantsFile: tenants() });
  expect(options).toMatchObject({
    host: '127.0.0.1',
    publicBind: false,
    tls: null,
  });
  const relay = await startRelay({ ...options, log: () => {} });
  try {
    expect((await fetch(`${relay.url}/admin`)).status).toBe(404);
    // An allowlisted tenant with no daemon connected: 404, as for any other.
    expect((await fetch(`${relay.url}/t/${TP}/a2a/v1/tasks/x`)).status).toBe(
      404
    );
  } finally {
    await relay.stop();
  }
});

it('names the relay in the a2a group', () => {
  const a2a = makeProgram({ cwd: dir, log: () => {} }).commands.find(
    (c) => c.name() === 'a2a'
  );
  expect(a2a?.commands.map((c) => c.name())).toContain('relay');
});
