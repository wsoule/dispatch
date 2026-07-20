import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CliContext } from '../src/context.js';
import { makeProgram } from '../src/program.js';

let root: string;
let ctx: CliContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-'));
  ctx = { cwd: root, log: () => {} };
});

describe('dispatch mcp', () => {
  // `mcp`'s action hands off to a real StdioServerTransport attached to
  // process stdio (via a dynamic import of @dispatch/mcp) and never
  // resolves on its own, so it can't be exercised through parseAsync() in
  // this process the way other commands are — doing so would hang the test
  // run. There is deliberately no requireStore() gate here either: per the
  // Phase 3 plan, the server's own tools re-resolve the store per call and
  // return a clean "not initialized" MCP tool error, so an uninitialized
  // repo is a valid state for this command to start in. Both the
  // not-initialized and success paths are proven end-to-end by spawning the
  // built binary in test/mcp-stdio-e2e.test.ts; this file only checks that
  // the command is wired up.
  it('is registered on the program without requiring .dispatch to exist', () => {
    const program = makeProgram(ctx);
    const cmd = program.commands.find((c) => c.name() === 'mcp');
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain('MCP server');
  });
});
