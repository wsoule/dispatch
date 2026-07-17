import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-'));
  lines = [];
  ctx = { cwd: root, log: l => lines.push(l) };
  await run('init');
});

describe('doctor', () => {
  it('reports ok on a healthy tracker', async () => {
    await run('task', 'create', 'Fine');
    lines = [];
    await run('doctor');
    expect(lines.join('\n')).toMatch(/ok — 1 task/);
  });
  it('flags unparsable files and dangling references', async () => {
    await run('task', 'create', 'Refs ghost', '--blocked-by', 't-ghost0');
    writeFileSync(join(root, '.dispatch/tasks/broken.md'), 'not a task file');
    await expect(run('doctor')).rejects.toThrow(/2 issue/);
    lines = [];
    await expect(run('doctor', '--json')).rejects.toThrow();
    const report = JSON.parse(lines.join('\n'));
    expect(report.ok).toBe(false);
    expect(report.issues).toHaveLength(2);
    expect(report.issues.map((i: { problem: string }) => i.problem).join(' ')).toMatch(/missing frontmatter/);
    expect(report.issues.map((i: { problem: string }) => i.problem).join(' ')).toMatch(/dangling blocked-by/);
  });
});
