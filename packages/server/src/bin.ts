#!/usr/bin/env bun
import { resolve } from 'node:path';

import { startServer } from './index.js';

// Minimal flag parsing (no commander dependency here — `@dispatch/cli` is the
// one place that owns the user-facing CLI surface; this bin is just what
// `dispatch serve` spawns).
function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1) return undefined;
  return args[index + 1];
}

const args = process.argv.slice(2);
const rootDir = resolve(readFlag(args, '--root') ?? process.cwd());
const portArg = readFlag(args, '--port');
const port = portArg !== undefined ? Number(portArg) : 0;

if (portArg !== undefined && Number.isNaN(port)) {
  console.error(`invalid --port: ${portArg}`);
  process.exit(1);
}

const handle = await startServer({ rootDir, port });
console.log(`dispatchd listening on http://127.0.0.1:${handle.port}`);

// Keep the daemon file accurate and the port free on Ctrl+C / kill. Signal
// listeners must be synchronous void functions, so the async work happens in
// a fire-and-forget helper rather than being returned from the listener
// itself.
async function shutdown() {
  await handle.stop();
  process.exit(0);
}
process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
