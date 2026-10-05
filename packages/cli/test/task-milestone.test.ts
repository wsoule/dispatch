import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CliContext } from '../src/context.js';
import { makeProgram } from '../src/program.js';

// `--milestone` files a task under a container by name; the task's own
// legacy `milestone` field is never written.

let root: string;
let lines: string[];
let ctx: CliContext;
let fakeHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

async function run(...argv: string[]) {
  await makeProgram(ctx).parseAsync(argv, { from: 'user' });
}

interface CreatedMeta {
  id: string;
  parent: string | null;
  milestone: string | null;
}

async function createJson(...argv: string[]): Promise<CreatedMeta> {
  lines = [];
  await run('task', 'create', ...argv, '--json');
  const doc = JSON.parse(lines.join('\n')) as { meta: CreatedMeta };
  return doc.meta;
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
  rmSync(root, { recursive: true, force: true });
});

describe('task create --milestone', () => {
  it('sets the parent to the container with that title', async () => {
    const project = await createJson('Payments', '--kind', 'project');
    const beta = await createJson(
      'Beta',
      '--kind',
      'milestone',
      '--parent',
      project.id
    );
    const task = await createJson('Refunds', '--milestone', 'beta');
    expect(task.parent).toBe(beta.id);
    expect(task.milestone).toBeNull();
  });

  it('errors on a name nothing has, creating nothing', async () => {
    await expect(
      run('task', 'create', 'Refunds', '--milestone', 'Gamma')
    ).rejects.toThrow(/no project or milestone is titled "Gamma"/);
    expect(new TaskStore(root).list()).toHaveLength(0);
  });

  it('errors when --parent names a different container', async () => {
    const beta = await createJson('Beta', '--kind', 'milestone');
    const other = await createJson('Other', '--kind', 'milestone');
    await expect(
      run('task', 'create', 'X', '--milestone', 'Beta', '--parent', other.id)
    ).rejects.toThrow(`"Beta" is ${beta.id}, but parent is ${other.id}`);
  });
});

describe('task edit --milestone', () => {
  it('moves the task under the named container', async () => {
    const beta = await createJson('Beta', '--kind', 'milestone');
    const gamma = await createJson('Gamma', '--kind', 'milestone');
    const task = await createJson('Refunds', '--parent', beta.id);
    await run('task', 'edit', task.id, '--milestone', 'Gamma');
    expect(new TaskStore(root).get(task.id)?.meta.parent).toBe(gamma.id);
  });
});
