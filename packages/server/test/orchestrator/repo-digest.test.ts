import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  headCommit,
  readRepoDigest,
  RepoDigestCache,
  repoDigestPath,
  writeRepoDigest,
} from '../../src/orchestrator/repoDigest.js';
import type { DigestResult } from '../../src/orchestrator/repoDigest.js';
import { initGitRepo, runGitSync } from './helpers.js';

// See the same note in hotspots.test.ts — without this redirect every write
// below lands in the developer's real ~/.dispatch.
const originalDispatchHome = process.env.DISPATCH_HOME;
let fakeHome: string;
let rootDir: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-digest-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  rootDir = initGitRepo('dispatch-digest-root-');
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

// Resolves once the cache's fire-and-forget refresh has settled. The refresh is
// deliberately not awaited in production (a run must never block on a model
// call), so a test has to yield the microtask queue to observe its effect.
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Every fake generator returns the DigestResult shape; most tests do not care
// about cost, so the noise stays here.
function generated(
  markdown: string,
  costUsd: number | null = null
): Promise<DigestResult> {
  return Promise.resolve({ markdown, costUsd });
}

function makeCommit(message: string): string {
  writeFileSync(join(rootDir, `${message}.txt`), `${message}\n`);
  runGitSync(rootDir, ['add', '-A']);
  runGitSync(rootDir, ['commit', '-m', message]);
  return runGitSync(rootDir, ['rev-parse', 'HEAD']).trim();
}

describe('readRepoDigest', () => {
  it('returns null when nothing has been cached yet', () => {
    expect(readRepoDigest(rootDir)).toBeNull();
  });

  it('round-trips a written digest', () => {
    writeRepoDigest(rootDir, {
      commit: 'abc1234',
      generatedAt: '2026-08-03T00:00:00.000Z',
      markdown: '# map',
    });
    expect(readRepoDigest(rootDir)).toEqual({
      commit: 'abc1234',
      generatedAt: '2026-08-03T00:00:00.000Z',
      markdown: '# map',
    });
  });

  it('round-trips a cost when one was recorded', () => {
    writeRepoDigest(rootDir, {
      commit: 'abc1234',
      generatedAt: '2026-08-03T00:00:00.000Z',
      markdown: '# map',
      costUsd: 0.0412,
    });
    expect(readRepoDigest(rootDir)?.costUsd).toBe(0.0412);
  });

  // The record is built field by field, so a cost that is not a number is
  // dropped rather than served as one.
  it('drops a non-numeric cost rather than rejecting the record', () => {
    const path = repoDigestPath(rootDir);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        commit: 'abc1234',
        generatedAt: '2026-08-03T00:00:00.000Z',
        markdown: '# map',
        costUsd: 'free',
      })
    );
    const read = readRepoDigest(rootDir);
    expect(read?.markdown).toBe('# map');
    expect(read?.costUsd).toBeUndefined();
  });

  it('treats a corrupt cache file as nothing cached rather than throwing', () => {
    const path = repoDigestPath(rootDir);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{not json');
    expect(readRepoDigest(rootDir)).toBeNull();
  });

  it('rejects a cache file missing the fields the prompt dereferences', () => {
    const path = repoDigestPath(rootDir);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({ commit: 'abc1234' }));
    expect(readRepoDigest(rootDir)).toBeNull();
  });

  it('rejects a cached digest whose markdown is empty', () => {
    const path = repoDigestPath(rootDir);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ commit: 'a', generatedAt: 'b', markdown: '' })
    );
    expect(readRepoDigest(rootDir)).toBeNull();
  });
});

describe('headCommit', () => {
  it('reads the checkout HEAD', () => {
    const expected = runGitSync(rootDir, ['rev-parse', 'HEAD']).trim();
    expect(headCommit(rootDir)).toBe(expected);
  });

  it('returns null outside a git checkout instead of throwing', () => {
    const plain = mkdtempSync(join(tmpdir(), 'dispatch-digest-plain-'));
    try {
      expect(headCommit(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('RepoDigestCache', () => {
  it('serves nothing and generates in the background on a cold cache', async () => {
    let calls = 0;
    const cache = new RepoDigestCache(rootDir, () => {
      calls += 1;
      return generated('# generated map');
    });

    // The first dispatch pays nothing and gets nothing — it must not block.
    expect(cache.current()).toBeNull();
    await settle();

    expect(calls).toBe(1);
    expect(readRepoDigest(rootDir)?.markdown).toBe('# generated map');
    const head = headCommit(rootDir);
    expect(head).not.toBeNull();
    expect(readRepoDigest(rootDir)?.commit).toBe(head as string);
  });

  it('serves the cached digest without regenerating while HEAD is unchanged', async () => {
    let calls = 0;
    const cache = new RepoDigestCache(rootDir, () => {
      calls += 1;
      return generated('# map');
    });
    cache.current();
    await settle();
    expect(calls).toBe(1);

    expect(cache.current()?.markdown).toBe('# map');
    await settle();
    expect(calls).toBe(1);
  });

  // The staleness guard: without the `cached.commit !== head` comparison the
  // cache would serve a map of a repo that has since moved, forever.
  it('regenerates after HEAD moves, and serves the stale map meanwhile', async () => {
    let markdown = '# map at first commit';
    const cache = new RepoDigestCache(rootDir, () => generated(markdown));
    cache.current();
    await settle();
    const firstCommit = headCommit(rootDir);
    expect(firstCommit).not.toBeNull();
    expect(readRepoDigest(rootDir)?.commit).toBe(firstCommit as string);

    const secondCommit = makeCommit('second');
    markdown = '# map at second commit';

    // Still serves the old map on the dispatch that discovers the staleness —
    // an out-of-date map labelled with its commit beats no map at all.
    expect(cache.current()?.markdown).toBe('# map at first commit');
    await settle();

    expect(readRepoDigest(rootDir)?.markdown).toBe('# map at second commit');
    expect(readRepoDigest(rootDir)?.commit).toBe(secondCommit);
  });

  it('persists what the generation cost', async () => {
    const cache = new RepoDigestCache(rootDir, () =>
      generated('# map', 0.0412)
    );
    cache.current();
    await settle();
    expect(readRepoDigest(rootDir)?.costUsd).toBe(0.0412);
  });

  it('omits the cost when the SDK did not report one', async () => {
    const cache = new RepoDigestCache(rootDir, () => generated('# map'));
    cache.current();
    await settle();
    const written = readRepoDigest(rootDir);
    expect(written?.markdown).toBe('# map');
    expect(written?.costUsd).toBeUndefined();
  });

  it('runs one generation at a time no matter how many dispatches race', async () => {
    let calls = 0;
    let release: (result: DigestResult) => void = () => {};
    const cache = new RepoDigestCache(rootDir, () => {
      calls += 1;
      return new Promise<DigestResult>((resolve) => {
        release = resolve;
      });
    });

    cache.current();
    cache.current();
    cache.current();
    expect(calls).toBe(1);

    release({ markdown: '# map', costUsd: null });
    await settle();
    expect(calls).toBe(1);
    expect(readRepoDigest(rootDir)?.markdown).toBe('# map');
  });

  it('retries on the next dispatch after a generation failure', async () => {
    let calls = 0;
    const cache = new RepoDigestCache(rootDir, () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error('no CLI on PATH'))
        : generated('# map');
    });

    cache.current();
    await settle();
    expect(calls).toBe(1);
    expect(readRepoDigest(rootDir)).toBeNull();

    cache.current();
    await settle();
    expect(calls).toBe(2);
    expect(readRepoDigest(rootDir)?.markdown).toBe('# map');
  });

  it('does not cache an empty generation, so a blank answer is retried', async () => {
    let calls = 0;
    const cache = new RepoDigestCache(rootDir, () => {
      calls += 1;
      return generated(calls === 1 ? '   \n  ' : '# map');
    });

    cache.current();
    await settle();
    expect(readRepoDigest(rootDir)).toBeNull();

    cache.current();
    await settle();
    expect(readRepoDigest(rootDir)?.markdown).toBe('# map');
  });

  it('serves the cache without generating when HEAD cannot be read', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'dispatch-digest-plain-'));
    let calls = 0;
    try {
      const cache = new RepoDigestCache(plain, () => {
        calls += 1;
        return generated('# map');
      });
      expect(cache.current()).toBeNull();
      await settle();
      // Nothing to key a cache entry on, so burning a model call would produce
      // a digest that could never be invalidated.
      expect(calls).toBe(0);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
