import { TaskStore } from '@dispatch/core';
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-milestones-'));
  lines = [];
  ctx = { cwd: root, log: (l) => lines.push(l) };
  makeProgram({ cwd: root, log: () => {} }).parse(['init'], { from: 'user' });
});

describe('dispatch migrate --milestones', () => {
  it('dry-runs, migrates with parity, and re-runs as a no-op', async () => {
    const store = new TaskStore(root);
    const a = store.create({ title: 'A', milestone: 'Q4' });
    store.create({ title: 'B', milestone: 'Q4' });

    await run('migrate', '--milestones', '--dry-run');
    expect(lines.join('\n')).toContain('Dry run');
    expect(store.list()).toHaveLength(2);

    lines = [];
    await run('migrate', '--milestones', '--json');
    const report = JSON.parse(lines.join('\n'));
    expect(report.parity).toBe(true);
    expect(report.tasksBefore).toBe(2);
    expect(report.tasksAfter).toBe(3);
    expect(report.projectsCreated).toHaveLength(1);
    expect(store.get(a.meta.id)!.meta.parent).toBe(report.projectsCreated[0]);

    lines = [];
    await run('migrate', '--milestones', '--json');
    const again = JSON.parse(lines.join('\n'));
    expect(again.projectsCreated).toEqual([]);
    expect(again.reparented).toEqual([]);
    expect(store.list()).toHaveLength(3);
  });
});
