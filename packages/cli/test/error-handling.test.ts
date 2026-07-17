import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskParseError, ConfigError } from '@dispatch/core';
import { makeProgram } from '../src/program.js';
import type { CliContext } from '../src/context.js';

let root: string;
let lines: string[];
let ctx: CliContext;

async function run(...argv: string[]) {
  await makeProgram(ctx).parseAsync(argv, { from: 'user' });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-'));
  lines = [];
  ctx = { cwd: root, log: l => lines.push(l) };
  await run('init');
  lines = [];
});

describe('corrupt task file propagation', () => {
  it('lets a TaskParseError from a corrupt task file reach the caller un-mangled', async () => {
    writeFileSync(
      join(root, '.dispatch/tasks/broken.md'),
      '---\nid: t-abc123\nstatus: todo\nkind: task\ncreated: 2026-07-13T00:00:00Z\nupdated: 2026-07-13T00:00:00Z\n---\nbody\n',
    );
    await expect(run('task', 'list')).rejects.toThrow(TaskParseError);
    await expect(run('task', 'list')).rejects.toThrow(/missing frontmatter field: title/);
  });
});

describe('malformed config propagation', () => {
  it('lets a ConfigError from malformed config.yml reach the caller on task create', async () => {
    writeFileSync(join(root, '.dispatch/config.yml'), 'statuses: [a\n');
    await expect(run('task', 'create', 'X')).rejects.toThrow(ConfigError);
    await expect(run('task', 'create', 'X')).rejects.toThrow(/invalid \.dispatch\/config\.yml/);
  });
});
