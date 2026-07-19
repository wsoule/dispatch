import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
  writeFileSync(
    join(root, '.dispatch/config.yml'),
    'statuses: [backlog, todo, in-progress, in-review, done, cancelled, deployed]\nautoCommit: false\n'
  );
  lines = [];
});

describe('config-driven statuses', () => {
  it('accepts a custom status defined in .dispatch/config.yml on create', async () => {
    await run('task', 'create', 'Ship it', '--status', 'deployed', '--json');
    const doc = JSON.parse(lines.join('\n'));
    expect(doc.meta.status).toBe('deployed');
  });

  it('lists tasks filtered by a custom status', async () => {
    await run('task', 'create', 'Ship it', '--status', 'deployed');
    lines = [];
    await run('task', 'list', '--status', 'deployed', '--json');
    const docs = JSON.parse(lines.join('\n'));
    expect(docs).toHaveLength(1);
    expect(docs[0].meta.status).toBe('deployed');
  });

  it('transitions a task to a custom status', async () => {
    lines = [];
    await run('task', 'create', 'Ship it', '--json');
    const id = JSON.parse(lines.join('\n')).meta.id as string;
    await run('task', 'status', id, 'deployed');
    lines = [];
    await run('task', 'show', id, '--json');
    expect(JSON.parse(lines.join('\n')).meta.status).toBe('deployed');
  });

  it('still rejects statuses absent from config', async () => {
    lines = [];
    await run('task', 'create', 'Ship it', '--json');
    const id = JSON.parse(lines.join('\n')).meta.id as string;
    await expect(run('task', 'status', id, 'shipped')).rejects.toThrow(
      /invalid status/
    );
  });
});
