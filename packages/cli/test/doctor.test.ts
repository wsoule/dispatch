import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type CliContext, CliError } from '../src/context.js';
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
    expect(
      report.issues.map((i: { problem: string }) => i.problem).join(' ')
    ).toMatch(/missing frontmatter/);
    expect(
      report.issues.map((i: { problem: string }) => i.problem).join(' ')
    ).toMatch(/dangling blocked-by/);
  });
  it('reports malformed config as a clean CliError', async () => {
    await run('task', 'create', 'Fine');
    writeFileSync(join(root, '.dispatch/config.yml'), 'statuses: [a\n');
    await expect(run('doctor')).rejects.toThrow(CliError);
    await expect(run('doctor')).rejects.toThrow(
      /invalid \.dispatch\/config\.yml/
    );
  });
  it('flags duplicate ids across files', async () => {
    await run('task', 'create', 'Only one id');
    const tasksDir = join(root, '.dispatch/tasks');
    const [original] = readdirSync(tasksDir).filter((f) => f.endsWith('.md'));
    const id = original.split('-').slice(0, 2).join('-');
    const contents = readFileSync(join(tasksDir, original), 'utf8');
    writeFileSync(join(tasksDir, `${id}-copy.md`), contents);
    lines = [];
    await expect(run('doctor')).rejects.toThrow(/1 issue/);
    lines = [];
    await expect(run('doctor', '--json')).rejects.toThrow();
    const report = JSON.parse(lines.join('\n'));
    expect(
      report.issues.map((i: { problem: string }) => i.problem).join(' ')
    ).toMatch(/duplicate id/);
  });

  it('flags an unparsable created/updated timestamp', async () => {
    await run('task', 'create', 'Bad stamp');
    const tasksDir = join(root, '.dispatch/tasks');
    const [file] = readdirSync(tasksDir).filter((f) => f.endsWith('.md'));
    const contents = readFileSync(join(tasksDir, file), 'utf8');
    writeFileSync(
      join(tasksDir, file),
      contents.replace(/^created:.*$/m, 'created: not-a-date')
    );
    lines = [];
    await expect(run('doctor', '--json')).rejects.toThrow(/1 issue/);
    const report = JSON.parse(lines.join('\n'));
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].problem).toBe(
      'invalid created timestamp: not-a-date'
    );
  });

  it('flags a parent that is not an epic', async () => {
    await run('task', 'create', 'Sibling');
    const tasksDir = join(root, '.dispatch/tasks');
    const [sibling] = readdirSync(tasksDir).filter((f) => f.endsWith('.md'));
    const siblingId = sibling.split('-').slice(0, 2).join('-');
    await run('task', 'create', 'Child', '--parent', siblingId);
    lines = [];
    await expect(run('doctor', '--json')).rejects.toThrow(/1 issue/);
    const report = JSON.parse(lines.join('\n'));
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].problem).toBe(
      `parent is not an epic: ${siblingId}`
    );
  });

  it('does not flag a parent that is an epic', async () => {
    const epicOut: string[] = [];
    ctx.log = (l) => epicOut.push(l);
    await run('task', 'create', 'The epic', '--kind', 'epic', '--json');
    const epicId = JSON.parse(epicOut.join('\n')).meta.id;
    ctx.log = (l) => lines.push(l);
    await run('task', 'create', 'Child', '--parent', epicId);
    lines = [];
    await run('doctor');
    expect(lines.join('\n')).toMatch(/ok — 2 tasks/);
  });

  it('flags a blockedBy self-reference', async () => {
    await run('task', 'create', 'Self blocker');
    const tasksDir = join(root, '.dispatch/tasks');
    const [file] = readdirSync(tasksDir).filter((f) => f.endsWith('.md'));
    const id = file.split('-').slice(0, 2).join('-');
    await run('task', 'edit', id, '--add-blocked-by', id);
    lines = [];
    await expect(run('doctor', '--json')).rejects.toThrow(/1 issue/);
    const report = JSON.parse(lines.join('\n'));
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].problem).toBe(`blocked-by self-reference: ${id}`);
  });

  it('flags a dependency cycle across tasks', async () => {
    const out: string[] = [];
    ctx.log = (l) => out.push(l);
    await run('task', 'create', 'A', '--json');
    const idA = JSON.parse(out.pop() as string).meta.id;
    await run('task', 'create', 'B', '--json');
    const idB = JSON.parse(out.pop() as string).meta.id;
    ctx.log = (l) => lines.push(l);
    await run('task', 'edit', idA, '--add-blocked-by', idB);
    await run('task', 'edit', idB, '--add-blocked-by', idA);
    lines = [];
    await expect(run('doctor', '--json')).rejects.toThrow(/1 issue/);
    const report = JSON.parse(lines.join('\n'));
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].problem).toMatch(/^dependency cycle: /);
    expect(report.issues[0].problem).toContain(idA);
    expect(report.issues[0].problem).toContain(idB);
  });

  it('attributes issues to the on-disk filename', async () => {
    await run('task', 'create', 'Refs ghost', '--blocked-by', 't-ghost0');
    const files = readdirSync(join(root, '.dispatch/tasks')).filter((f) =>
      f.endsWith('.md')
    );
    expect(files).toHaveLength(1);
    lines = [];
    await expect(run('doctor', '--json')).rejects.toThrow();
    const report = JSON.parse(lines.join('\n'));
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].file).toMatch(/\.md$/);
    expect(report.issues[0].file).toBe(files[0]);
  });
});
