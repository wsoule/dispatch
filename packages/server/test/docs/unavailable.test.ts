import { openSqliteDb } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { runsDir } from '../../src/orchestrator/paths.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { useTestAuth } from '../testAuth.js';

let fakeHome: string;
let root: string;
let handle: ServerHandle;
const originalHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'docs-home-')));
  process.env.DISPATCH_HOME = fakeHome;
  root = realpathSync(initGitRepo('docs-unavailable-'));
  mkdirSync(runsDir(root), { recursive: true });
  const newer = openSqliteDb(join(runsDir(root), 'docs.db'));
  newer.exec('PRAGMA user_version = 2');
  newer.close();
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
  });
  useTestAuth(handle);
});

afterEach(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('review focus 3: boots with docs unavailable when docs.db is newer', () => {
  it('serves the board, answers docs routes 503 with the reason, and reports it in health', async () => {
    const base = `http://127.0.0.1:${handle.port}/api`;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/tasks`)).status).toBe(200);
    const res = await fetch(`${base}/docs`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain(
      'written by a newer schema (version 2'
    );
    const health = (await (await fetch(`${base}/docs/health`)).json()) as {
      available: boolean;
      reason: string;
    };
    expect(health.available).toBe(false);
    expect(health.reason).toContain('newer schema');
  });
});
