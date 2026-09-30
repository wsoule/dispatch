import { createMemoryIds, newMemoryEntry } from '@dispatch/memory';
import { afterAll, expect, it } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../../src/index.js';
import {
  memoryReceiptsStep,
  memoryRestoreDir,
} from '../../src/memory/receipts.js';
import { runsDir } from '../../src/orchestrator/paths.js';
import { testEngine } from '../memory/fixtures.js';
import { initGitRepo } from '../orchestrator/helpers.js';

const originalHome = process.env.DISPATCH_HOME;
const home = realpathSync(mkdtempSync(join(tmpdir(), 'memory-restore-home-')));
const log = realpathSync(mkdtempSync(join(tmpdir(), 'memory-restore-log-')));
afterAll(() => {
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(log, { recursive: true, force: true });
});

it('a receipt log restores team memory on a clean machine as agent proposals', async () => {
  // Machine A: the real step writes the log's .dispatch/memory/.
  const a = testEngine();
  const entry = newMemoryEntry(
    {
      scope: 'team',
      kind: 'hazard',
      title: 'the release cache keys need runner.arch',
      body: 'an Intel build restored an arm64 binary',
      author: 'human:wyat',
      trust: 'human',
    },
    createMemoryIds().entry(Date.now()),
    new Date().toISOString()
  );
  a.shared.insertEntry(entry, 'human:wyat', 'save');
  expect(
    memoryReceiptsStep(() => a.shared, join(log, 'no-staging'))(log).changed
  ).toBe(1);

  // Machine B: `dispatch receipts restore` stages under its run-state dir.
  process.env.DISPATCH_HOME = home;
  const root = realpathSync(initGitRepo('memory-restore-'));
  const staging = memoryRestoreDir(root);
  expect(staging).toBe(join(runsDir(root), 'memory-restore'));
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  for (const f of readdirSync(join(log, '.dispatch', 'memory')))
    copyFileSync(join(log, '.dispatch', 'memory', f), join(staging, f));

  const handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
  });
  try {
    const shared = handle.memory.shared;
    expect(shared).not.toBeNull();
    const proposals = shared?.listProposals() ?? [];
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      scope: 'team',
      authorTrust: 'agent',
      origin: `receipts:${entry.id}`,
      content: { kind: 'hazard', title: entry.title, body: entry.body },
    });
    // Nothing restored ever stands as a human's entry.
    expect(
      shared
        ?.listEntries({ scopes: ['team'] })
        .filter((e) => e.trust !== 'agent')
    ).toEqual([]);
    expect(existsSync(staging)).toBe(false);
  } finally {
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
