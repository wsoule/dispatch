import { TaskStore } from '@dispatch-foo/core';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';

// The suite boots and stops servers thousands of times in one process, so
// anything a cycle leaves open accumulates until spawns fail with EMFILE. A
// daemon boots once, so this is the only place such a leak shows up.

// Where this process's open descriptors can be listed; other platforms skip.
const FD_DIR =
  process.platform === 'linux'
    ? '/proc/self/fd'
    : process.platform === 'darwin'
      ? '/dev/fd'
      : null;

const CYCLES = 20;

function openFds(): number {
  return readdirSync(FD_DIR as string).length;
}

let fakeHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-fds-home-'));
  process.env.DISPATCH_HOME = fakeHome;
});

afterAll(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

async function bootAndStop(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-fds-'));
  try {
    runGitSync(root, ['init', '-b', 'main']);
    runGitSync(root, ['config', 'user.email', 'test@example.com']);
    runGitSync(root, ['config', 'user.name', 'Test']);
    writeFileSync(join(root, 'README.md'), '# test repo\n');
    runGitSync(root, ['add', '-A']);
    runGitSync(root, ['commit', '-m', 'initial commit']);
    TaskStore.init(root);
    const handle = await startServer({
      rootDir: root,
      port: 0,
      webDistDir: null,
      writeDaemonFile: false,
    });
    await handle.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(FD_DIR === null)('startServer → stop()', () => {
  it(
    `leaves no descriptors open across ${CYCLES} cycles`,
    async () => {
      // First boots pay one-time costs (the shared watchdog thread, lazily
      // opened module state) that are not per-cycle leaks.
      await bootAndStop();
      await bootAndStop();
      const before = openFds();
      for (let i = 0; i < CYCLES; i++) await bootAndStop();
      // A leak of even one fd per cycle grows by CYCLES; the slack absorbs
      // descriptors that are merely mid-close when the count is taken.
      expect(openFds() - before).toBeLessThan(CYCLES / 4);
    },
    { timeout: 60_000 }
  );
});
