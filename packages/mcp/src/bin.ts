#!/usr/bin/env node
import { runStdioServer } from './server.js';

// Minimal `--root <dir>` parsing — this bin has exactly one flag, so a
// dependency like commander would be overkill (unlike @dispatch/cli, which
// has a real subcommand surface).
function parseRoot(argv: string[]): string {
  const i = argv.indexOf('--root');
  return i === -1 ? process.cwd() : (argv[i + 1] ?? process.cwd());
}

await runStdioServer(parseRoot(process.argv.slice(2)));
