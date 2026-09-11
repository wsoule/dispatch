import { dispatchDbPath, TaskStore } from '@dispatch/core';
// Subprocess half of watchdog-teardown.test.ts. The watchdog's stall lines
// are written by a worker thread straight to stderr, which no in-process spy
// can see — so the test runs this script and reads the real stderr.
//
// Every scenario boots a server, then holds the event loop for longer than
// the watchdog threshold. Which side of the block the boot or its teardown
// lands on is the whole difference between them:
//
//   stopped      start, stop, then block — must log nothing
//   boot-failed  start rejects mid-boot, then block — must log nothing
//   running      start, block, then stop — the positive control: the stall
//                is real and the line must appear, or the two above prove
//                nothing about the harness
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../../src/index.js';

const STALL_MS = 200;
// The worker polls once a second (see watchdog.ts), so a block has to span
// several polls for the stall to be seen at all — a shorter one can fall
// entirely between two checks and the positive control would go quiet.
const BLOCK_MS = 2_500;

function blockEventLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // busy
  }
}

const scenario = process.argv[2];
const root = mkdtempSync(join(tmpdir(), 'dispatch-watchdog-teardown-'));
// The merge queue persists under DISPATCH_HOME; keep it out of the real one.
const home = mkdtempSync(join(tmpdir(), 'dispatch-watchdog-teardown-home-'));
process.env.DISPATCH_HOME = home;
TaskStore.init(root);

try {
  if (scenario === 'boot-failed') {
    // The database file's path is a directory, so the sqlite backend cannot
    // open — startServer rejects after its watchdog is already armed.
    mkdirSync(dispatchDbPath(root), { recursive: true });
    let rejected = false;
    try {
      await startServer({
        rootDir: root,
        port: 0,
        writeDaemonFile: false,
        webDistDir: null,
        storeBackend: 'sqlite',
        watchdogStallMs: STALL_MS,
      });
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error('expected startServer to reject');
    blockEventLoop(BLOCK_MS);
  } else {
    const handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      webDistDir: null,
      watchdogStallMs: STALL_MS,
    });
    if (scenario === 'stopped') {
      await handle.stop();
      blockEventLoop(BLOCK_MS);
    } else if (scenario === 'running') {
      blockEventLoop(BLOCK_MS);
      await handle.stop();
    } else {
      throw new Error(`unknown scenario: ${String(scenario)}`);
    }
  }
  // Long enough for the worker's next check to see (or not see) the gap.
  await Bun.sleep(1_500);
  console.log('scenario complete');
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
