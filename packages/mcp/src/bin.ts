#!/usr/bin/env node
import { parseRootArg } from './argv.js';
import { runStdioServer } from './server.js';

const parsed = parseRootArg(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`dispatch-mcp: ${parsed.error}`);
  process.exit(1);
}

await runStdioServer(parsed.root);
