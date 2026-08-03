import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CliContext } from '../src/context.js';
import { makeProgram } from '../src/program.js';

let root: string;
let lines: string[];
let ctx: CliContext;

// `task status` now resolves an ActorContext (git identity + team.yml
// roster), which writes a known-handle file under DISPATCH_HOME — isolate it
// per the shared test-setup contract (see packages/server/test/setup.ts).
let fakeHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

async function run(...argv: string[]) {
  await makeProgram(ctx).parseAsync(argv, { from: 'user' });
}

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-cli-home-'));
  process.env.DISPATCH_HOME = fakeHome;
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

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
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
