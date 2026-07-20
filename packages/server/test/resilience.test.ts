import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';

// `Response.json()` types as `Promise<unknown>` under this repo's strict,
// DOM-less tsconfig; same escape hatch as api.test.ts.
function json(res: Response): Promise<any> {
  return res.json();
}

// Waits for `check` to become true, polling every `intervalMs`, rejecting
// after `timeoutMs` — used below to wait for the watcher's debounced rebuild
// to land without hardcoding a sleep duration.
async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
}

let root: string;
let handle: ServerHandle | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-server-resilience-'));
});

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
});

describe('boot with a corrupt task file already on disk', () => {
  it('starts anyway, serves the good tasks, and reports the problem via health', async () => {
    const store = TaskStore.init(root);
    store.create({ title: 'Good task' }, '2026-07-13T01:00:00Z');
    writeFileSync(join(store.tasksDir, 'corrupt.md'), 'no frontmatter here');

    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;

    const health = await json(await fetch(`${baseUrl}/api/health`));
    expect(health.ok).toBe(true);
    expect(health.problems).toEqual(['corrupt.md: missing frontmatter']);

    const tasks = await json(await fetch(`${baseUrl}/api/tasks`));
    expect(tasks.map((t: { meta: { title: string } }) => t.meta.title)).toEqual(
      ['Good task']
    );
  });
});

describe('a task file going bad while the daemon is running', () => {
  it('stays alive and keeps serving the last-good cache, then recovers once fixed', async () => {
    const store = TaskStore.init(root);
    store.create({ title: 'Good task' }, '2026-07-13T01:00:00Z');

    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;

    // Confirm the daemon is healthy and serving the one good task before
    // introducing corruption.
    const before = await json(await fetch(`${baseUrl}/api/tasks`));
    expect(before).toHaveLength(1);

    const corruptFile = join(store.tasksDir, 'corrupt.md');
    writeFileSync(corruptFile, 'no frontmatter here');

    // The watcher debounces at 100ms; wait for the rebuild to notice the new
    // file and surface it as a health problem instead of crashing the
    // process.
    await waitFor(async () => {
      const health = await json(await fetch(`${baseUrl}/api/health`));
      return health.ok === true && health.problems.length > 0;
    });

    const healthWhileCorrupt = await json(await fetch(`${baseUrl}/api/health`));
    expect(healthWhileCorrupt.ok).toBe(true);
    expect(healthWhileCorrupt.problems).toEqual([
      'corrupt.md: missing frontmatter',
    ]);

    const tasksWhileCorrupt = await json(await fetch(`${baseUrl}/api/tasks`));
    expect(tasksWhileCorrupt).toHaveLength(1);

    // Fix the file in place — same id/kind, valid frontmatter this time —
    // and confirm it reappears and the health problem clears.
    writeFileSync(
      corruptFile,
      [
        '---',
        'id: t-cafe01',
        'title: Fixed',
        'status: todo',
        'kind: task',
        'created: 2026-07-13T02:00:00Z',
        'updated: 2026-07-13T02:00:00Z',
        '---',
        '',
      ].join('\n')
    );

    await waitFor(async () => {
      const health = await json(await fetch(`${baseUrl}/api/health`));
      return health.problems.length === 0;
    });

    const tasksAfterFix = await json(await fetch(`${baseUrl}/api/tasks`));
    expect(
      tasksAfterFix.map((t: { meta: { title: string } }) => t.meta.title).sort()
    ).toEqual(['Fixed', 'Good task']);
  });
});
