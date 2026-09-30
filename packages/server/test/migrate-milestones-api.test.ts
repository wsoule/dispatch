import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-milestones-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

let root: string;
let fakeHome: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  // startServer hydrates the merge queue, which writes run state under
  // DISPATCH_HOME — left unset it lands in the real home, one dir per test.
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('POST /api/migrations/milestones', () => {
  it('dry-runs, migrates with parity and refreshes the board', async () => {
    const store = new TaskStore(root);
    const task = store.create({ title: 'Ship', milestone: 'Beta' });
    const post = (value: unknown) =>
      fetch(`${baseUrl}/api/migrations/milestones`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
    // Written straight to the store: the migration reads the store, not the
    // daemon's cache, so it sees this without a rebuild.

    const dry = await json<{ dryRun: boolean; reparented: unknown[] }>(
      await post({ dryRun: true })
    );
    expect(dry.dryRun).toBe(true);
    expect(dry.reparented).toHaveLength(1);
    expect(store.get(task.meta.id)!.meta.parent).toBeNull();

    const real = await json<{
      parity: boolean;
      projectsCreated: string[];
    }>(await post({}));
    expect(real.parity).toBe(true);
    expect(real.projectsCreated).toHaveLength(1);
    const listed = await json<
      { meta: { id: string; parent: string | null } }[]
    >(await fetch(`${baseUrl}/api/tasks`));
    expect(listed.find((t) => t.meta.id === task.meta.id)?.meta.parent).toBe(
      real.projectsCreated[0]
    );
    expect((await post({ dryRun: 'yes' })).status).toBe(400);
  });
});
