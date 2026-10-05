import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { json } from './json.js';
import { runGitSync } from './orchestrator/helpers.js';
import { rawFetch, useTestAuth } from './testAuth.js';

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-files-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const answer = 42;\n');
  writeFileSync(
    join(dir, 'src', 'BoardView.tsx'),
    'export function BoardView() {}\n'
  );
  // A real PNG header, so binary detection is exercised against actual bytes
  // rather than a string that merely contains a NUL.
  writeFileSync(
    join(dir, 'logo.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
  );
  writeFileSync(join(dir, '.gitignore'), 'ignored/\n');
  mkdirSync(join(dir, 'ignored'), { recursive: true });
  writeFileSync(join(dir, 'ignored', 'secret.ts'), 'nope\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type'))
    headers.set('content-type', 'application/json');
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  TaskStore.init(root);
  handle = await startServer({ rootDir: root, port: 0 });
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

describe('GET /api/files/tree', () => {
  it('lists the root with directories first', async () => {
    const body = await json(await apiFetch('/api/files/tree'));
    const names = body.entries.map((e: { name: string }) => e.name);
    const kinds = body.entries.map((e: { kind: string }) => e.kind);
    // Directories lead, which is what every file tree does.
    expect(kinds.indexOf('file')).toBeGreaterThan(
      kinds.lastIndexOf('directory')
    );
    expect(names).toContain('src');
    expect(names).toContain('README.md');
  });

  it('lists a subdirectory with paths relative to the scope', async () => {
    const body = await json(await apiFetch('/api/files/tree?path=src'));
    expect(body.path).toBe('src');
    expect(body.entries.map((e: { path: string }) => e.path).sort()).toEqual([
      'src/BoardView.tsx',
      'src/index.ts',
    ]);
  });

  it('404s a path that is not a directory', async () => {
    expect((await apiFetch('/api/files/tree?path=README.md')).status).toBe(404);
  });
});

describe('GET /api/files/read', () => {
  it('returns text with its metadata', async () => {
    const body = await json(
      await apiFetch('/api/files/read?path=src/index.ts')
    );
    expect(body.kind).toBe('text');
    expect(body.text).toBe('export const answer = 42;\n');
    expect(body.size).toBeGreaterThan(0);
  });

  it('reports a binary file rather than returning mojibake', async () => {
    const body = await json(await apiFetch('/api/files/read?path=logo.png'));
    expect(body.kind).toBe('binary');
    expect(body.text).toBeNull();
    expect(body.mime).toBe('image/png');
    expect(body.preview).toBe('image');
  });

  it('404s a missing file', async () => {
    expect((await apiFetch('/api/files/read?path=nope.ts')).status).toBe(404);
  });
});

describe('POST /api/files/write', () => {
  it('saves an edit and reports the new size', async () => {
    const saved = await json(
      await apiFetch('/api/files/write', {
        method: 'POST',
        body: JSON.stringify({
          path: 'src/index.ts',
          text: 'export const answer = 7;\n',
        }),
      })
    );
    expect(saved.path).toBe('src/index.ts');

    const read = await json(
      await apiFetch('/api/files/read?path=src/index.ts')
    );
    expect(read.text).toBe('export const answer = 7;\n');
  });

  it('creates parent directories for a new file', async () => {
    await apiFetch('/api/files/write', {
      method: 'POST',
      body: JSON.stringify({ path: 'a/b/c/new.ts', text: 'hi\n' }),
    });
    const read = await json(
      await apiFetch('/api/files/read?path=a/b/c/new.ts')
    );
    expect(read.text).toBe('hi\n');
  });

  it('validates the body', async () => {
    expect(
      (
        await apiFetch('/api/files/write', {
          method: 'POST',
          body: JSON.stringify({ text: 'no path' }),
        })
      ).status
    ).toBe(400);
    expect(
      (
        await apiFetch('/api/files/write', {
          method: 'POST',
          body: JSON.stringify({ path: 'a.ts', text: 42 }),
        })
      ).status
    ).toBe(400);
  });

  it('keeps writes off the agent token', async () => {
    // Reads are fine on the request tier; a general-purpose write would be a
    // way around the orchestrator's scope enforcement.
    const res = await rawFetch(`${baseUrl}/api/files/write`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${handle.tokens.agentToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ path: 'src/index.ts', text: 'owned\n' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/files/raw', () => {
  it('serves bytes with the right content type', async () => {
    const res = await apiFetch('/api/files/raw?path=logo.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    // Never cached: the bytes come from a checkout that changes underfoot.
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await res.arrayBuffer()).byteLength).toBe(10);
  });
});

describe('path traversal', () => {
  // The guard every one of these routes depends on. A single missing check
  // here turns a file browser into arbitrary filesystem read/write.
  const escapes = [
    '../../etc/passwd',
    'src/../../../etc/passwd',
    '/etc/passwd',
    'src/../..',
  ];

  it('refuses to read outside the project', async () => {
    for (const path of escapes) {
      const res = await apiFetch(
        `/api/files/read?path=${encodeURIComponent(path)}`
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      if (res.status === 400) {
        expect((await json(res)).error).toContain('inside the project');
      }
    }
  });

  it('refuses to write outside the project', async () => {
    for (const path of escapes) {
      const res = await apiFetch('/api/files/write', {
        method: 'POST',
        body: JSON.stringify({ path, text: 'owned' }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('refuses to list outside the project', async () => {
    for (const path of escapes) {
      const res = await apiFetch(
        `/api/files/tree?path=${encodeURIComponent(path)}`
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });

  it('refuses a run id that climbs out of the worktrees directory', async () => {
    // The run id names the directory `path` is checked against, so a run id
    // of `../..` would move the fence itself: every `path` below would pass
    // the inside-the-base check against a base of the caller's choosing.
    writeFileSync(join(fakeHome, 'secret.txt'), 'the operator’s own file\n');
    for (const runId of ['../../..', '../../../..', '..', '.', 'r-1/../..']) {
      for (const route of ['read', 'tree', 'raw']) {
        const path = route === 'tree' ? '' : 'secret.txt';
        const res = await apiFetch(
          `/api/files/${route}?runId=${encodeURIComponent(runId)}&path=${path}`
        );
        expect(res.status).toBe(400);
        expect(await res.text()).not.toContain('the operator’s own file');
      }
    }
  });

  it('is not fooled by a sibling directory sharing the root’s prefix', async () => {
    // `/tmp/repo-backup` must not count as inside `/tmp/repo`.
    const res = await apiFetch(
      `/api/files/read?path=${encodeURIComponent('../' + root.split('/').pop() + '-backup/x')}`
    );
    expect(res.status).toBe(400);
  });

  describe('through a symlink that points outside', () => {
    // A symlink passes a check on the path's text, so the guard has to look at
    // where the path really lands on disk.
    let outside: string;

    beforeEach(() => {
      outside = mkdtempSync(join(tmpdir(), 'dispatch-files-outside-'));
      writeFileSync(join(outside, 'secret.txt'), 'outside the project\n');
      symlinkSync(outside, join(root, 'escape'));
    });

    afterEach(() => {
      rmSync(outside, { recursive: true, force: true });
    });

    it('refuses to read through it', async () => {
      const res = await apiFetch(
        `/api/files/read?path=${encodeURIComponent('escape/secret.txt')}`
      );
      expect(res.status).toBe(400);
    });

    it('refuses to list through it', async () => {
      const res = await apiFetch(
        `/api/files/tree?path=${encodeURIComponent('escape')}`
      );
      expect(res.status).toBe(400);
    });

    it('refuses to write through it, including a new file', async () => {
      for (const path of ['escape/secret.txt', 'escape/new/created.txt']) {
        const res = await apiFetch('/api/files/write', {
          method: 'POST',
          body: JSON.stringify({ path, text: 'owned' }),
        });
        expect(res.status).toBe(400);
      }
      expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe(
        'outside the project\n'
      );
      expect(existsSync(join(outside, 'new'))).toBe(false);
    });

    it('still serves a symlink that stays inside the project', async () => {
      symlinkSync(join(root, 'src'), join(root, 'src-link'));
      const res = await apiFetch(
        `/api/files/read?path=${encodeURIComponent('src-link/index.ts')}`
      );
      expect(res.status).toBe(200);
    });
  });
});

describe('GET /api/files/search', () => {
  it('ranks a name match first', async () => {
    const body = await json(await apiFetch('/api/files/search?q=boardView'));
    expect(body.results[0]?.path).toBe('src/BoardView.tsx');
  });

  it('matches an initialism across segments', async () => {
    const body = await json(await apiFetch('/api/files/search?q=sbv'));
    expect(body.results.map((r: { path: string }) => r.path)).toContain(
      'src/BoardView.tsx'
    );
  });

  it('honours .gitignore, so build output never crowds the results', async () => {
    const body = await json(await apiFetch('/api/files/search?q=secret'));
    expect(body.results.map((r: { path: string }) => r.path)).not.toContain(
      'ignored/secret.ts'
    );
  });

  it('returns a first page for an empty query', async () => {
    const body = await json(await apiFetch('/api/files/search?q='));
    expect(body.results.length).toBeGreaterThan(0);
  });

  it('caps the result count', async () => {
    const body = await json(await apiFetch('/api/files/search?q=&limit=2'));
    expect(body.results).toHaveLength(2);
  });

  it('400s a run with no worktree', async () => {
    const res = await apiFetch('/api/files/search?q=x&runId=not-a-run');
    expect(res.status).toBe(400);
  });
});
