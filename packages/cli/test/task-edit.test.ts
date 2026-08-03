import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CliContext } from '../src/context.js';
import { makeProgram } from '../src/program.js';

let root: string;
let lines: string[];
let ctx: CliContext;

// `task status` resolves an ActorContext (git identity + team.yml roster),
// which writes a known-handle file under DISPATCH_HOME — isolate it per the
// shared test-setup contract (see packages/server/test/setup.ts).
let fakeHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

async function run(...argv: string[]) {
  await makeProgram(ctx).parseAsync(argv, { from: 'user' });
}

async function createTask(title: string): Promise<string> {
  lines = [];
  await run('task', 'create', title, '--json');
  return JSON.parse(lines.join('\n')).meta.id as string;
}

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-cli-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-'));
  lines = [];
  ctx = { cwd: root, log: (l) => lines.push(l) };
  await run('init');
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('task show', () => {
  it('prints the raw markdown file', async () => {
    const id = await createTask('Show me');
    lines = [];
    await run('task', 'show', id);
    expect(lines.join('\n')).toContain('title: Show me');
    expect(lines.join('\n')).toContain('## Description');
  });
  it('errors on unknown id', async () => {
    await expect(run('task', 'show', 't-nope00')).rejects.toThrow(
      /task not found/
    );
  });
});

describe('task status', () => {
  it('updates status and logs activity', async () => {
    const id = await createTask('Move me');
    await run('task', 'status', id, 'in-progress');
    lines = [];
    await run('task', 'show', id);
    const out = lines.join('\n');
    expect(out).toContain('status: in-progress');
    expect(out).toMatch(/- .*status → in-progress/);
  });
  it('rejects unknown status', async () => {
    const id = await createTask('X');
    await expect(run('task', 'status', id, 'shipped')).rejects.toThrow(
      /invalid status/
    );
  });
});

describe('task status id-prefix guard', () => {
  it('rejects a degenerate id instead of matching an arbitrary task file', async () => {
    await createTask('Innocent bystander');
    await expect(run('task', 'status', 't', 'done')).rejects.toThrow(
      /task not found: t/
    );
  });
});

describe('task edit', () => {
  it('patches fields additively', async () => {
    const id = await createTask('Edit me');
    await run(
      'task',
      'edit',
      id,
      '--priority',
      'urgent',
      '--add-label',
      'infra'
    );
    lines = [];
    await run('task', 'show', id, '--json');
    const doc = JSON.parse(lines.join('\n'));
    expect(doc.meta.priority).toBe('urgent');
    expect(doc.meta.labels).toContain('infra');
  });
});
