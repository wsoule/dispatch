import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProgram } from '../src/program.js';
import type { CliContext } from '../src/context.js';

let root: string;
let lines: string[];
let ctx: CliContext;

async function run(...argv: string[]) {
  await makeProgram(ctx).parseAsync(argv, { from: 'user' });
}

async function createTask(...args: string[]): Promise<string> {
  lines = [];
  await run('task', 'create', ...args, '--json');
  return JSON.parse(lines.join('\n')).meta.id as string;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-'));
  lines = [];
  ctx = { cwd: root, log: l => lines.push(l) };
  await run('init');
});

describe('task next', () => {
  it('lists only unblocked todo tasks, priority first', async () => {
    const blocker = await createTask('Blocker');
    await createTask('Blocked', '--blocked-by', blocker);
    await createTask('Urgent free', '--priority', 'urgent');
    lines = [];
    await run('task', 'next', '--json');
    const docs = JSON.parse(lines.join('\n'));
    const titles = docs.map((d: { meta: { title: string } }) => d.meta.title);
    expect(titles[0]).toBe('Urgent free');
    expect(titles).toContain('Blocker');
    expect(titles).not.toContain('Blocked');
  });
  it('unblocks when the blocker is done', async () => {
    const blocker = await createTask('Blocker');
    await createTask('Blocked', '--blocked-by', blocker);
    await run('task', 'status', blocker, 'done');
    lines = [];
    await run('task', 'next', '--json');
    const titles = JSON.parse(lines.join('\n')).map((d: { meta: { title: string } }) => d.meta.title);
    expect(titles).toContain('Blocked');
  });
});
