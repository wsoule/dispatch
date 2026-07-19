import { beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CliContext } from '../src/context.js';
import { makeProgram } from '../src/program.js';

let root: string;
let lines: string[];
let ctx: CliContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-'));
  lines = [];
  ctx = { cwd: root, log: (l) => lines.push(l) };
});

describe('dispatch init', () => {
  it('scaffolds .dispatch and reports success', async () => {
    await makeProgram(ctx).parseAsync(['init'], { from: 'user' });
    expect(existsSync(join(root, '.dispatch/tasks'))).toBe(true);
    expect(existsSync(join(root, '.dispatch/config.yml'))).toBe(true);
    expect(lines.join('\n')).toContain('Initialized');
  });
  it('is idempotent', async () => {
    await makeProgram(ctx).parseAsync(['init'], { from: 'user' });
    await makeProgram(ctx).parseAsync(['init'], { from: 'user' });
    expect(lines.join('\n')).toContain('already initialized');
  });
});
