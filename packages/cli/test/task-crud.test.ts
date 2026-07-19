import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CliContext } from '../src/context.js';
import { makeProgram } from '../src/program.js';

let root: string;
let lines: string[];
let ctx: CliContext;

async function run(...argv: string[]) {
  await makeProgram(ctx).parseAsync(argv, { from: 'user' });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-'));
  lines = [];
  ctx = { cwd: root, log: (l) => lines.push(l) };
  await run('init');
  lines = [];
});

describe('task create', () => {
  it('prints the new id and --json emits the doc', async () => {
    await run('task', 'create', 'Fix login', '--priority', 'high', '--json');
    const doc = JSON.parse(lines.join('\n'));
    expect(doc.meta.id).toMatch(/^t-[0-9a-f]{6}$/);
    expect(doc.meta.priority).toBe('high');
  });
  it('fails outside an initialized repo', async () => {
    ctx = {
      cwd: mkdtempSync(join(tmpdir(), 'other-')),
      log: (l) => lines.push(l),
    };
    await expect(run('task', 'create', 'X')).rejects.toThrow(/not initialized/);
  });
  it('rejects invalid priority', async () => {
    await expect(
      run('task', 'create', 'X', '--priority', 'huge')
    ).rejects.toThrow(/invalid priority/);
  });
  it('rejects an empty title', async () => {
    await expect(run('task', 'create', '')).rejects.toThrow(
      /title must not be empty/
    );
  });
  it('rejects a whitespace-only title', async () => {
    await expect(run('task', 'create', '   ')).rejects.toThrow(
      /title must not be empty/
    );
  });
});

describe('task list', () => {
  it('renders a table and honors --status filter', async () => {
    await run('task', 'create', 'One');
    await run('task', 'create', 'Two', '--status', 'backlog');
    lines = [];
    await run('task', 'list');
    const out = lines.join('\n');
    expect(out).toContain('ID');
    expect(out).toContain('One');
    lines = [];
    await run('task', 'list', '--status', 'backlog', '--json');
    const docs = JSON.parse(lines.join('\n'));
    expect(docs).toHaveLength(1);
    expect(docs[0].meta.title).toBe('Two');
  });
});
