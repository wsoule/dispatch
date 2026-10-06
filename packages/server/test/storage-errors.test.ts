import { openSqliteDb } from '@dispatch-foo/core';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { storageErrorResponse } from '../src/api/storageErrors.js';
import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

const errno = (code: string, message = code): Error =>
  Object.assign(new Error(message), { code });

describe('storageErrorResponse', () => {
  it('answers a busy database with 503 and Retry-After', () => {
    for (const err of [
      errno('SQLITE_BUSY', 'database is locked'),
      errno('SQLITE_BUSY_SNAPSHOT'),
      errno('SQLITE_LOCKED'),
    ]) {
      const res = storageErrorResponse(err);
      expect(res?.status).toBe(503);
      expect(res?.headers.get('retry-after')).toBe('1');
    }
  });

  it('answers a write the disk refused with 507 and what to fix', async () => {
    const cases: [Error, string][] = [
      [errno('ENOSPC'), 'disk is full'],
      [errno('EROFS'), 'read-only'],
      [errno('EACCES'), 'permission'],
      [errno('SQLITE_FULL'), 'disk is full'],
      [errno('SQLITE_READONLY'), 'read-only'],
    ];
    for (const [err, words] of cases) {
      const res = storageErrorResponse(err);
      if (res === null) throw new Error(`no answer for ${err.message}`);
      expect(res.status).toBe(507);
      expect(((await res.json()) as { error: string }).error).toContain(words);
    }
  });

  it('leaves any other error alone', () => {
    expect(storageErrorResponse(new Error('boom'))).toBeNull();
    expect(storageErrorResponse('nope')).toBeNull();
  });
});

describe('a busy dispatch.db over HTTP', () => {
  let handle: ServerHandle | undefined;
  const dirs: string[] = [];
  const originalHome = process.env.DISPATCH_HOME;
  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    if (originalHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalHome;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('answers 503 with Retry-After while another writer holds the lock', async () => {
    const home = mkdtempSync(join(tmpdir(), 'busy-home-'));
    const root = mkdtempSync(join(tmpdir(), 'busy-project-'));
    dirs.push(home, root);
    process.env.DISPATCH_HOME = home;
    runGitSync(root, ['init', '-q', '-b', 'main']);
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    handle = await startServer({
      rootDir: root,
      port: 0,
      webDistDir: null,
      writeDaemonFile: false,
      storeBackend: 'sqlite',
    });
    useTestAuth(handle);
    const other = openSqliteDb(join(root, '.dispatch', 'dispatch.db'));
    other.exec('BEGIN IMMEDIATE');
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Blocked' }),
      });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
  });
});
