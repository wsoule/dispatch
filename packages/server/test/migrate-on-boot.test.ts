import { DISPATCH_DIR, dispatchDbPath, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { json } from './json.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// The boot half of the one-time import: a daemon told to serve a project on
// the database backend must move that project's existing markdown and JSONL
// across BEFORE it answers a single request, and must record the move only
// once it has committed. These drive the real HTTP surface rather than the
// import function directly — the thing that would actually break is a daemon
// serving an empty board over a real one.

let root: string;
let fakeHome: string;
let handle: ServerHandle | null = null;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-migrate-boot-'));
  runGitSync(root, ['init', '-b', 'main']);
  runGitSync(root, ['config', 'user.email', 'test@example.com']);
  runGitSync(root, ['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'README.md'), '# test repo\n');
  runGitSync(root, ['add', '-A']);
  runGitSync(root, ['commit', '-m', 'initial commit']);
});

afterEach(async () => {
  await handle?.stop();
  handle = null;
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// A legacy project: markdown tasks written by the file backend, plus the two
// JSONL sidecars, and no storage marker.
function seedLegacyProject(): void {
  const store = TaskStore.init(root);
  const epic = store.create({ title: 'Storage spine', kind: 'epic' });
  const task = store.create({
    title: 'Import the board',
    blockedBy: [epic.meta.id],
  });
  writeFileSync(
    join(root, DISPATCH_DIR, 'findings.jsonl'),
    `${JSON.stringify({
      id: 'f-aaa111',
      taskId: task.meta.id,
      runId: null,
      severity: 'important',
      verdict: 'open',
      title: 'Unhandled null',
      detail: 'It explodes',
      file: null,
      line: null,
      ruling: null,
      round: 0,
      createdAt: '2026-02-02T00:00:00.000Z',
      updatedAt: '2026-02-02T00:00:00.000Z',
      raisedBy: 'agent:claude',
    })}\n`
  );
  writeFileSync(
    join(root, DISPATCH_DIR, 'ledger.jsonl'),
    `${JSON.stringify({
      id: 'l-aaa111',
      epicId: epic.meta.id,
      sourceTaskId: null,
      kind: 'decision',
      title: 'Use SQLite',
      detail: 'A file cannot hold a transaction',
      appliesTo: [],
      createdAt: '2026-02-02T00:00:00.000Z',
      authoredBy: 'human:wyat',
    })}\n`
  );
}

async function boot(): Promise<ServerHandle> {
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    webDistDir: null,
    storeBackend: 'sqlite',
    boardSyncPeriodicMs: 10 * 60_000,
  });
  useTestAuth(handle);
  return handle;
}

function markerBackend(): string | null {
  const path = join(root, DISPATCH_DIR, 'storage.json');
  if (!existsSync(path)) return null;
  return (JSON.parse(readFileSync(path, 'utf8')) as { backend: string })
    .backend;
}

describe('first boot on the database backend', () => {
  it('serves the imported board rather than an empty one', async () => {
    seedLegacyProject();
    const server = await boot();
    const listed = await json(
      await fetch(`http://127.0.0.1:${server.port}/api/tasks`)
    );
    expect(
      listed.map((d: { meta: { title: string } }) => d.meta.title).sort()
    ).toEqual(['Import the board', 'Storage spine']);
  });

  it('preserves ids, timestamps and blocked-by edges through the move', async () => {
    seedLegacyProject();
    const before = new TaskStore(root).list();
    const server = await boot();
    const listed: { meta: Record<string, unknown> }[] = await json(
      await fetch(`http://127.0.0.1:${server.port}/api/tasks`)
    );
    const byId = new Map(listed.map((d) => [d.meta.id as string, d.meta]));
    for (const doc of before) {
      const moved = byId.get(doc.meta.id);
      expect(moved?.created).toBe(doc.meta.created);
      expect(moved?.updated).toBe(doc.meta.updated);
      expect(moved?.blockedBy).toEqual(doc.meta.blockedBy);
    }
  });

  it('brings findings and ledger entries across too', async () => {
    seedLegacyProject();
    const server = await boot();
    const findings = await json(
      await fetch(`http://127.0.0.1:${server.port}/api/findings`)
    );
    expect(findings.map((f: { id: string }) => f.id)).toEqual(['f-aaa111']);
    expect(findings[0].createdAt).toBe('2026-02-02T00:00:00.000Z');
  });

  it('records the project as database-backed once the import committed', async () => {
    seedLegacyProject();
    expect(markerBackend()).toBeNull();
    await boot();
    expect(markerBackend()).toBe('sqlite');
    expect(existsSync(dispatchDbPath(root))).toBe(true);
  });

  it('leaves every source file where it was', async () => {
    seedLegacyProject();
    await boot();
    expect(new TaskStore(root).list()).toHaveLength(2);
    expect(existsSync(join(root, DISPATCH_DIR, 'findings.jsonl'))).toBe(true);
    expect(existsSync(join(root, DISPATCH_DIR, 'ledger.jsonl'))).toBe(true);
  });
});

describe('later boots', () => {
  // The import is gated on the marker, not on the files, which is what keeps
  // stale markdown from reinstating records the daemon has moved past.
  it('do not re-import over changes the daemon has since made', async () => {
    seedLegacyProject();
    const first = await boot();
    const listed: { meta: { id: string; title: string } }[] = await json(
      await fetch(`http://127.0.0.1:${first.port}/api/tasks`)
    );
    const target = listed.find((d) => d.meta.title === 'Import the board');
    await fetch(`http://127.0.0.1:${first.port}/api/tasks/${target?.meta.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    await first.stop();
    handle = null;

    // The markdown file still says the task is todo. A second boot must not
    // let it win.
    expect(new TaskStore(root).get(target?.meta.id ?? '')?.meta.status).toBe(
      'todo'
    );
    const second = await boot();
    const after: { meta: { id: string; status: string } }[] = await json(
      await fetch(`http://127.0.0.1:${second.port}/api/tasks`)
    );
    expect(after.find((d) => d.meta.id === target?.meta.id)?.meta.status).toBe(
      'done'
    );
  });
});

describe('a project with nothing to import', () => {
  it('boots on the database backend without inventing a board', async () => {
    const server = await boot();
    expect(
      await json(await fetch(`http://127.0.0.1:${server.port}/api/tasks`))
    ).toEqual([]);
    expect(markerBackend()).toBe('sqlite');
    // The import never ran, so nothing scaffolded a tasks directory.
    expect(existsSync(join(root, DISPATCH_DIR, 'tasks'))).toBe(false);
  });
});

describe('a legacy project whose import cannot complete', () => {
  // The import is one transaction. If it throws, the database is empty and
  // every source file is untouched — so the project's real board is still the
  // markdown on disk, and coming up would serve an empty board over it.
  it('refuses to start rather than serving an empty board over a real one', async () => {
    seedLegacyProject();
    // A directory where the database file has to go: openDispatchDb cannot
    // create a database at that path, so the boot fails before it serves.
    mkdirSync(dispatchDbPath(root), { recursive: true });
    await expect(boot()).rejects.toThrow();
    expect(markerBackend()).toBeNull();
    expect(new TaskStore(root).list()).toHaveLength(2);
  });
});
