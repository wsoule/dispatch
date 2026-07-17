import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProgram } from '../src/program.js';
import { CliError, type CliContext } from '../src/context.js';

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
  it('reports malformed config as a clean CliError', async () => {
    await run('task', 'create', 'Fine');
    writeFileSync(join(root, '.dispatch/config.yml'), 'statuses: [a\n');
    await expect(run('doctor')).rejects.toThrow(CliError);
    await expect(run('doctor')).rejects.toThrow(/invalid \.dispatch\/config\.yml/);
  });
  it('flags duplicate ids across files', async () => {
    await run('task', 'create', 'Only one id');
    const tasksDir = join(root, '.dispatch/tasks');
    const [original] = readdirSync(tasksDir).filter(f => f.endsWith('.md'));
    const id = original.split('-').slice(0, 2).join('-');
    const contents = readFileSync(join(tasksDir, original), 'utf8');
    writeFileSync(join(tasksDir, `${id}-copy.md`), contents);
    lines = [];
    await expect(run('doctor')).rejects.toThrow(/1 issue/);
    lines = [];
    await expect(run('doctor', '--json')).rejects.toThrow();
    const report = JSON.parse(lines.join('\n'));
    expect(report.issues.map((i: { problem: string }) => i.problem).join(' ')).toMatch(/duplicate id/);
  });

  it('attributes issues to the on-disk filename', async () => {
    await run('task', 'create', 'Refs ghost', '--blocked-by', 't-ghost0');
    const files = readdirSync(join(root, '.dispatch/tasks')).filter(f => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    lines = [];
    await expect(run('doctor', '--json')).rejects.toThrow();
    const report = JSON.parse(lines.join('\n'));
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].file).toMatch(/\.md$/);
    expect(report.issues[0].file).toBe(files[0]);
  });
});
