import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CliError } from './context.js';

// The dispatch entry `dispatch init` writes into `.mcp.json`'s `mcpServers`
// map. `command: 'dispatch'` assumes the CLI is on PATH (the packaged
// installer story lands in a later phase — see README).
const DISPATCH_SERVER_ENTRY = { command: 'dispatch', args: ['mcp'] };

interface McpConfigDoc {
  mcpServers?: unknown;
  [key: string]: unknown;
}

// Merges the `dispatch` server entry into a `.mcp.json` document's
// `mcpServers` map, preserving every other top-level key and every other
// registered server untouched. Pure (no filesystem access) so the merge
// logic itself is easy to test in isolation from `registerMcpServer`'s I/O.
// `existingRaw` is the current file's text, or `undefined` when no file
// exists yet. Throws CliError on unparsable JSON rather than silently
// overwriting whatever the user already had there.
export function mergeMcpConfig(existingRaw: string | undefined): string {
  let doc: McpConfigDoc = {};
  if (existingRaw !== undefined) {
    try {
      doc = JSON.parse(existingRaw) as McpConfigDoc;
    } catch (err) {
      throw new CliError(`invalid .mcp.json: ${(err as Error).message}`);
    }
  }
  const rawServers = doc.mcpServers;
  if (
    rawServers !== undefined &&
    (typeof rawServers !== 'object' ||
      rawServers === null ||
      Array.isArray(rawServers))
  ) {
    throw new CliError('invalid .mcp.json: mcpServers must be an object');
  }
  const mcpServers = {
    ...(rawServers as Record<string, unknown> | undefined),
    dispatch: DISPATCH_SERVER_ENTRY,
  };
  return `${JSON.stringify({ ...doc, mcpServers }, null, 2)}\n`;
}

// Reads (if present), merges, and writes `<cwd>/.mcp.json` — the filesystem
// side of mergeMcpConfig(), called from `dispatch init` unless `--no-mcp`.
export function registerMcpServer(cwd: string): void {
  const path = join(cwd, '.mcp.json');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  writeFileSync(path, mergeMcpConfig(existing));
}
