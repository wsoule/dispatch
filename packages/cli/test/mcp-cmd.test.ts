import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CliError } from '../src/context.js';
import type { CliContext } from '../src/context.js';
import { makeProgram } from '../src/program.js';

let root: string;
let ctx: CliContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-'));
  ctx = { cwd: root, log: () => {} };
});

describe('dispatch mcp', () => {
  // requireStore() runs before the dynamic import of @dispatch/mcp (see
  // program.ts), so an uninitialized repo fails fast with the same message
  // every other command uses, without ever touching the MCP SDK.
  it('fails fast with the standard not-initialized error', async () => {
    await expect(
      makeProgram(ctx).parseAsync(['mcp'], { from: 'user' })
    ).rejects.toThrow(CliError);
    await expect(
      makeProgram(ctx).parseAsync(['mcp'], { from: 'user' })
    ).rejects.toThrow(/not initialized — run: dispatch init/);
  });
});
