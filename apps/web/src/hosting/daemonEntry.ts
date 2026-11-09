#!/usr/bin/env bun
// One hosted workspace's dispatchd, spawned by WorkspaceHost (host.ts): a
// hosted planner (only planning routes, no runs, no egress but Linear) whose
// state and credentials live under its own DISPATCH_HOME. Prints its port and
// app token on stdout for the host, which is the only caller holding the app
// token; members reach it with teammate tokens the host mints.
import { writeLinearAccount } from '@dispatch-foo/core';
import { parseLinearAccountRecord } from '@dispatch-foo/core';
import { startServer } from '@dispatch/server/embed';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const rootArg = process.argv[process.argv.indexOf('--root') + 1];
const home = process.env.DISPATCH_HOME;
if (rootArg === undefined || home === undefined || home === '') {
  console.error('usage: DISPATCH_HOME=<dir> daemonEntry.ts --root <dir>');
  process.exit(1);
}

// A workspace install handed over by the host: stored as this home's one
// Linear account (the hosted planner's project connection), then removed.
const pending = join(home, 'install.json');
if (existsSync(pending)) {
  const record = parseLinearAccountRecord(
    JSON.parse(readFileSync(pending, 'utf8')) as unknown
  );
  rmSync(pending, { force: true });
  if (record === null) {
    console.error('install.json is not a Linear account record');
    process.exit(1);
  }
  await writeLinearAccount(record);
}

// Read once and dropped, so nothing the daemon spawns inherits it.
const clientSecret = process.env.DISPATCH_LINEAR_CLIENT_SECRET?.trim() ?? '';
delete process.env.DISPATCH_LINEAR_CLIENT_SECRET;

const handle = await startServer({
  rootDir: resolve(rootArg),
  port: 0,
  webDistDir: null,
  hubLink: false,
  writeDaemonFile: false,
  hostedPlanner: true,
  ...(clientSecret === '' ? {} : { linearOAuth: { clientSecret } }),
});

console.log(`dispatchd listening on http://127.0.0.1:${String(handle.port)}`);
console.log(`DISPATCH_APP_TOKEN=${handle.tokens.appToken}`);

async function shutdown(): Promise<void> {
  await handle.stop();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
