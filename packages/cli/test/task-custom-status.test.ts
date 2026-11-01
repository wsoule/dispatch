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

// A board linked to Linear: none of its names is a built-in, and its review
// status is its dispatched one.
const LINEAR_CONFIG = `statuses:
  - { name: Backlog, type: backlog }
  - { name: Todo, type: unstarted }
  - { name: In Progress, type: started }
  - { name: Done, type: completed }
  - { name: Canceled, type: canceled }
statusRoles:
  ready: Todo
  dispatched: In Progress
  review: In Progress
  landing: null
  landed: Done
  dropped: Canceled
autoCommit: false
`;

describe('statuses on a Linear board', () => {
  beforeEach(() => {
    writeFileSync(join(root, '.dispatch/config.yml'), LINEAR_CONFIG);
  });

  async function created(
    ...flags: string[]
  ): Promise<{ id: string; status: string }> {
    lines = [];
    await run('task', 'create', 'Ship it', ...flags, '--json');
    const doc = JSON.parse(lines.join('\n')) as {
      meta: { id: string; status: string };
    };
    return doc.meta;
  }

  it('starts a local create in the ready role', async () => {
    expect((await created()).status).toBe('Todo');
  });

  it('maps built-in words through the roles and matches names by case', async () => {
    expect((await created('--status', 'landed')).status).toBe('Done');
    expect((await created('--status', 'draft')).status).toBe('Backlog');
    expect((await created('--status', 'in progress')).status).toBe(
      'In Progress'
    );
  });

  it('moves a task by a lowercase name', async () => {
    const { id } = await created();
    lines = [];
    await run('task', 'status', id, 'done');
    expect(lines).toEqual([`${id} → Done`]);
  });

  it('lists by a resolved status', async () => {
    await created('--status', 'Done');
    await created();
    lines = [];
    await run('task', 'list', '--status', 'landed', '--json');
    const docs = JSON.parse(lines.join('\n')) as { meta: { status: string } }[];
    expect(docs.map((d) => d.meta.status)).toEqual(['Done']);
  });

  it('refuses a word with no status on the board, naming what was typed', async () => {
    await expect(created('--status', 'shipped')).rejects.toThrow(
      'invalid status: shipped (expected Backlog|Todo|In Progress|Done|Canceled)'
    );
    await expect(created('--status', 'landing')).rejects.toThrow(
      /invalid status: landing/
    );
  });
});
