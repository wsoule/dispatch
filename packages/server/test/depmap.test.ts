import type {
  CartoBlastRadius,
  CartoReader,
  CartoRunResult,
} from '@dispatch/core/carto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import {
  buildDepMap,
  createCartoDepMap,
  createSourceChangeHandler,
  DepMapCache,
  depMapSourceDirs,
  isSkippedPath,
  normalizeBlastRadius,
} from '../src/depmap.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-depmap-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// A two-package workspace: `b` imports `a`'s helper via its bare specifier,
// and `a`'s own test imports it by relative path.
function writeFixtureWorkspace(): void {
  mkdirSync(join(root, 'packages/a/src'), { recursive: true });
  mkdirSync(join(root, 'packages/a/test'), { recursive: true });
  mkdirSync(join(root, 'packages/b/src'), { recursive: true });
  writeFileSync(
    join(root, 'packages/a/package.json'),
    JSON.stringify({
      name: '@dispatch/a',
      exports: { '.': { import: './dist/index.js' } },
    })
  );
  writeFileSync(
    join(root, 'packages/b/package.json'),
    JSON.stringify({
      name: '@dispatch/b',
      exports: { '.': { import: './dist/index.js' } },
    })
  );
  writeFileSync(
    join(root, 'packages/a/src/util.ts'),
    'export function helper(): number {\n  return 1;\n}\n'
  );
  writeFileSync(
    join(root, 'packages/a/src/index.ts'),
    "export { helper } from './util.js';\n"
  );
  writeFileSync(
    join(root, 'packages/a/test/util.test.ts'),
    "import { helper } from '../src/util.js';\nhelper();\n"
  );
  writeFileSync(
    join(root, 'packages/b/src/consumer.ts'),
    "// Mirrors helper in packages/a/src/util.ts\nimport { helper } from '@dispatch/a';\nhelper();\n"
  );
}

describe('buildDepMap over a fixture tree', () => {
  it('finds direct and transitive dependents across a bare-specifier package boundary', () => {
    writeFixtureWorkspace();
    const map = buildDepMap(root);
    expect(map.dependents('packages/a/src/util.ts')).toEqual([
      'packages/a/src/index.ts',
      'packages/a/test/util.test.ts',
      'packages/b/src/consumer.ts',
    ]);
  });

  it('finds no dependents for a file nothing imports', () => {
    writeFixtureWorkspace();
    const map = buildDepMap(root);
    expect(map.dependents('packages/b/src/consumer.ts')).toEqual([]);
  });

  it('sorts dependents by hop distance before name, so depth beats the alphabet', () => {
    writeFixtureWorkspace();
    // A direct importer named to sort alphabetically LAST, and a two-hop
    // importer named to sort FIRST — proves depth wins, not the alphabet.
    writeFileSync(
      join(root, 'packages/b/src/zzz-direct.ts'),
      "import { helper } from '@dispatch/a';\nhelper();\n"
    );
    writeFileSync(
      join(root, 'packages/b/src/aaa-indirect.ts'),
      "import { x } from './zzz-direct.js';\nx;\n"
    );
    const map = buildDepMap(root);
    const dependents = map.dependents('packages/a/src/util.ts');
    const directIndex = dependents.indexOf('packages/b/src/zzz-direct.ts');
    const indirectIndex = dependents.indexOf('packages/b/src/aaa-indirect.ts');
    expect(directIndex).toBeGreaterThanOrEqual(0);
    expect(indirectIndex).toBeGreaterThan(directIndex);
  });

  it('detects a mirror comment in the brief-literal "X in path" form', () => {
    writeFixtureWorkspace();
    const map = buildDepMap(root);
    expect(map.mirrors('packages/a/src/util.ts')).toEqual([
      'packages/b/src/consumer.ts',
    ]);
  });

  it('detects a mirror comment in this repo\'s real "path\'s X" form', () => {
    mkdirSync(join(root, 'packages/a/src'), { recursive: true });
    mkdirSync(join(root, 'packages/b/src'), { recursive: true });
    writeFileSync(
      join(root, 'packages/a/package.json'),
      JSON.stringify({ name: '@dispatch/a' })
    );
    writeFileSync(
      join(root, 'packages/b/package.json'),
      JSON.stringify({ name: '@dispatch/b' })
    );
    writeFileSync(
      join(root, 'packages/a/src/events.ts'),
      'export type X = 1;\n'
    );
    // Copied verbatim from packages/cli/src/apiClient.ts's real comment.
    writeFileSync(
      join(root, 'packages/b/src/apiClient.ts'),
      "// Mirrors packages/a/src/events.ts's ServerEvent union exactly — the\nexport type Y = 1;\n"
    );
    const map = buildDepMap(root);
    expect(map.mirrors('packages/a/src/events.ts')).toEqual([
      'packages/b/src/apiClient.ts',
    ]);
  });

  it('does not chase mirror claims transitively', () => {
    writeFixtureWorkspace();
    writeFileSync(
      join(root, 'packages/b/src/consumer2.ts'),
      '// Mirrors helper in packages/b/src/consumer.ts\nexport const x = 1;\n'
    );
    const map = buildDepMap(root);
    expect(map.mirrors('packages/a/src/util.ts')).toEqual([
      'packages/b/src/consumer.ts',
    ]);
  });
});

describe('DepMapCache', () => {
  it('memoizes until invalidated', () => {
    writeFixtureWorkspace();
    const cache = new DepMapCache(root);
    const first = cache.get();
    expect(first.dependents('packages/a/src/util.ts')).toContain(
      'packages/b/src/consumer.ts'
    );

    // A new consumer written after the first .get() should be invisible
    // until the cache is told to invalidate.
    writeFileSync(
      join(root, 'packages/b/src/consumer3.ts'),
      "import { helper } from '@dispatch/a';\nhelper();\n"
    );
    expect(cache.get().dependents('packages/a/src/util.ts')).not.toContain(
      'packages/b/src/consumer3.ts'
    );

    cache.invalidate();
    expect(cache.get().dependents('packages/a/src/util.ts')).toContain(
      'packages/b/src/consumer3.ts'
    );
  });
});

describe('depMapSourceDirs', () => {
  it('lists the workspace roots, not each member — so a package added later is still covered', () => {
    writeFixtureWorkspace();
    expect(depMapSourceDirs(root)).toEqual([join(root, 'packages')]);
  });

  it('falls back to the project root when there is no packages/apps layout', () => {
    expect(depMapSourceDirs(root)).toEqual([root]);
  });
});

describe('isSkippedPath', () => {
  it('flags a path that passes through any skipped directory segment', () => {
    expect(isSkippedPath('mcp/dist/index.js')).toBe(true);
    expect(isSkippedPath('server/node_modules/foo/index.js')).toBe(true);
    expect(isSkippedPath('.dispatch/runs/r-1.jsonl')).toBe(true);
    expect(isSkippedPath('.git/HEAD')).toBe(true);
    // carto's own output: without this, a sync's writes re-arm the watcher
    // that triggered it, which loops on any repo watched at its root.
    expect(isSkippedPath('.carto/carto.db')).toBe(true);
    expect(isSkippedPath('.carto/CONTEXT.md')).toBe(true);
  });

  it('does not flag an ordinary source path', () => {
    expect(isSkippedPath('packages/server/src/depmap.ts')).toBe(false);
  });
});

// Run against this actual repository rather than a synthetic fixture, so
// this proves the map against the real files it needs to work on.
describe('buildDepMap against this repository', () => {
  const repoRoot = join(import.meta.dirname, '..', '..', '..');

  it("detects packages/client/src/api.ts's real mirror comments for packages/server/src/events.ts", () => {
    const map = buildDepMap(repoRoot);
    expect(map.mirrors('packages/server/src/events.ts')).toContain(
      'packages/client/src/api.ts'
    );
  });

  it('finds the real consumers of packages/mcp/src/tools.ts via static imports', () => {
    const map = buildDepMap(repoRoot);
    const dependents = map.dependents('packages/mcp/src/tools.ts');
    expect(dependents).toContain('packages/mcp/src/server.ts');
    expect(dependents).toContain('packages/mcp/src/index.ts');
    // program.ts reaches tools.ts transitively via its dynamic mcp import.
    expect(dependents).toContain('packages/cli/src/program.ts');
    // Known gap: this test spawns the built CLI rather than importing it, so
    // no static edge reaches it — it is correctly NOT found here.
    expect(dependents).not.toContain('packages/cli/test/mcp-stdio-e2e.test.ts');
  });
});

// A reader that answers from a canned map, standing in for a real container.
function fakeReader(
  map: Record<string, { count: number; hops: number; files: unknown[] }>
): CartoReader {
  return {
    blastRadius: (file: string) =>
      map[file] ?? { count: 0, hops: 0, files: [] },
  };
}

describe('createCartoDepMap', () => {
  it('answers dependents from carto', () => {
    const depMap = createCartoDepMap(
      root,
      fakeReader({
        'src/a.ts': {
          count: 2,
          hops: 2,
          files: [
            { path: 'src/c.ts', hops: 2 },
            { path: 'src/b.ts', hops: 1 },
          ],
        },
      }),
      buildDepMap(root)
    );
    // Direct importer first — depth beats the alphabet, matching buildDepMap.
    expect(depMap.dependents('src/a.ts')).toEqual(['src/b.ts', 'src/c.ts']);
  });

  it('falls back to the scanner when carto throws', () => {
    writeFixtureWorkspace();
    const fallback = buildDepMap(root);
    const throwing: CartoReader = {
      blastRadius: () => {
        throw new Error('container corrupt');
      },
    };
    const depMap = createCartoDepMap(root, throwing, fallback);
    expect(depMap.dependents('packages/a/src/index.ts')).toEqual(
      fallback.dependents('packages/a/src/index.ts')
    );
  });

  it('caches the failure instead of retrying per file', () => {
    let calls = 0;
    const throwing: CartoReader = {
      blastRadius: () => {
        calls += 1;
        throw new Error('container corrupt');
      },
    };
    const depMap = createCartoDepMap(root, throwing, buildDepMap(root));
    depMap.dependents('src/a.ts');
    depMap.dependents('src/b.ts');
    depMap.dependents('src/c.ts');
    expect(calls).toBe(1);
  });

  it('always serves mirrors from the scanner, never from carto', () => {
    writeFixtureWorkspace();
    const fallback = buildDepMap(root);
    const depMap = createCartoDepMap(root, fakeReader({}), fallback);
    expect(depMap.mirrors('packages/a/src/index.ts')).toEqual(
      fallback.mirrors('packages/a/src/index.ts')
    );
  });

  it('normalizes the recorded real carto response', () => {
    const raw = JSON.parse(
      readFileSync(
        join(import.meta.dirname, 'fixtures/carto-blast-radius.json'),
        'utf8'
      )
    ) as CartoBlastRadius;
    const files = normalizeBlastRadius(raw);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => typeof f === 'string')).toBe(true);
    // Ordering must be non-decreasing in hop distance, like buildDepMap's.
    expect(files).toEqual([...new Set(files)]);
  });

  it('sorts the fixture by hop distance then name, independent of normalizeBlastRadius itself', () => {
    const raw = JSON.parse(
      readFileSync(
        join(import.meta.dirname, 'fixtures/carto-blast-radius.json'),
        'utf8'
      )
    ) as CartoBlastRadius;
    // Expected order computed straight off the fixture's own `file` /
    // `hop_distance` keys, not by re-running the function under test.
    const expected = (raw.files as { file: string; hop_distance: number }[])
      .slice()
      .sort((a, b) =>
        a.hop_distance !== b.hop_distance
          ? a.hop_distance - b.hop_distance
          : a.file < b.file
            ? -1
            : a.file > b.file
              ? 1
              : 0
      )
      .map((e) => e.file);
    expect(normalizeBlastRadius(raw)).toEqual(expected);
  });

  it('dedupes a path reachable by two routes, keeping the closer hop', () => {
    const raw = JSON.parse(
      readFileSync(
        join(import.meta.dirname, 'fixtures/carto-blast-radius.json'),
        'utf8'
      )
    ) as CartoBlastRadius;
    // The fixture already lists this path once at hop 5; add a second route
    // to it at hop 1, as carto would if two different files imported it.
    const duplicated: CartoBlastRadius = {
      ...raw,
      files: [
        ...raw.files,
        { file: 'apps/desktop/src/main.tsx', hop_distance: 1 },
      ],
    };
    const files = normalizeBlastRadius(duplicated);
    // No new path was added, so the unique count is unchanged.
    expect(files.length).toBe(raw.files.length);
    expect(files.filter((f) => f === 'apps/desktop/src/main.tsx').length).toBe(
      1
    );
    // Sorted at hop 1's position (alphabetically first there), not hop 5's.
    expect(files[0]).toBe('apps/desktop/src/main.tsx');
  });
});

describe('DepMapCache backend selection', () => {
  it('uses the scanner when carto is off', () => {
    writeFixtureWorkspace();
    const cache = new DepMapCache(root, { mode: 'off' });
    expect(cache.get().dependents('packages/a/src/index.ts')).toEqual(
      buildDepMap(root).dependents('packages/a/src/index.ts')
    );
  });

  it('reports one degradation, not one per call', () => {
    writeFixtureWorkspace();
    const seen: string[] = [];
    // No .carto/ in the fixture root, so carto selection always misses.
    const cache = new DepMapCache(root, {
      mode: 'detect',
      onDegrade: (d) => seen.push(d.detail),
    });
    cache.get().dependents('packages/a/src/index.ts');
    cache.get().dependents('packages/b/src/index.ts');
    expect(seen.length).toBeLessThanOrEqual(1);
  });

  it('does not build a container when the mode is detect', () => {
    writeFixtureWorkspace();
    const cache = new DepMapCache(root, { mode: 'detect' });
    cache.get();
    expect(existsSync(join(root, '.carto'))).toBe(false);
  });

  it('attempts carto init at most once across invalidations', () => {
    writeFixtureWorkspace();
    // A stub binary that reports a supported version but always fails to
    // produce a container, logging one line per `init` invocation. Unlike
    // this machine's real carto-md (which leaves a half-written .carto/ that
    // itself blocks a second attempt via openCartoReader's "load-failed"
    // path), this stub leaves nothing behind, so `openCartoReader` keeps
    // reporting 'no-container' on every call — the initAttempted guard is
    // the ONLY thing standing between this and a respawn per invalidation.
    const binDir = join(root, 'fake-carto-bin');
    mkdirSync(binDir, { recursive: true });
    const stub = join(binDir, 'carto');
    const initLog = join(root, 'init-calls.log');
    writeFileSync(
      stub,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "2.9.9"\nelif [ "$1" = "init" ]; then\n  echo x >> "${initLog}"\n  exit 1\nelse\n  exit 1\nfi\n`
    );
    chmodSync(stub, 0o755);
    const originalPath = process.env.PATH;
    const originalDisabled = process.env.DISPATCH_CARTO_DISABLED;
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`;
    // packages/cli's preload sets this when `bun test` runs from the repo
    // root; the stub above is exactly what this test wants discovered.
    delete process.env.DISPATCH_CARTO_DISABLED;
    try {
      const seen: string[] = [];
      const cache = new DepMapCache(root, {
        mode: 'on',
        onDegrade: (d) => seen.push(d.detail),
      });
      cache.get();
      cache.invalidate();
      cache.get();
      cache.invalidate();
      cache.get();
      expect(seen.length).toBeLessThanOrEqual(1);
      const initCalls = existsSync(initLog)
        ? readFileSync(initLog, 'utf8')
            .split('\n')
            .filter((l) => l !== '').length
        : 0;
      expect(initCalls).toBe(1);
    } finally {
      process.env.PATH = originalPath;
      if (originalDisabled !== undefined) {
        process.env.DISPATCH_CARTO_DISABLED = originalDisabled;
      }
    }
  });
});

describe('createSourceChangeHandler', () => {
  // A CartoDiscovery for a binary that is never actually spawned: the
  // handler's sync is injected in every test below.
  const foundBinary = {
    ok: true as const,
    binary: { path: '/nonexistent/carto', version: '2.9.9' },
  };

  function countingCache(counter: { invalidations: number }): DepMapCache {
    const cache = new DepMapCache(root, { mode: 'off' });
    const original = cache.invalidate.bind(cache);
    cache.invalidate = () => {
      counter.invalidations += 1;
      original();
    };
    return cache;
  }

  it('invalidates the cache without syncing when there is no container', () => {
    const counter = { invalidations: 0 };
    let syncs = 0;
    const handler = createSourceChangeHandler({
      rootDir: root,
      mode: 'on',
      cache: countingCache(counter),
      discover: () => foundBinary,
      sync: () => {
        syncs += 1;
        return Promise.resolve({ ok: true, detail: 'synced' });
      },
    });
    handler();
    expect(counter.invalidations).toBe(1);
    expect(syncs).toBe(0);
  });

  it('never syncs or discovers when the mode is off', () => {
    mkdirSync(join(root, '.carto'), { recursive: true });
    const counter = { invalidations: 0 };
    let discoveries = 0;
    let syncs = 0;
    const handler = createSourceChangeHandler({
      rootDir: root,
      mode: 'off',
      cache: countingCache(counter),
      discover: () => {
        discoveries += 1;
        return foundBinary;
      },
      sync: () => {
        syncs += 1;
        return Promise.resolve({ ok: true, detail: 'synced' });
      },
    });
    handler();
    expect(counter.invalidations).toBe(1);
    expect(discoveries).toBe(0);
    expect(syncs).toBe(0);
  });

  it('runs one sync at a time and discovers carto only once', async () => {
    mkdirSync(join(root, '.carto'), { recursive: true });
    const counter = { invalidations: 0 };
    let discoveries = 0;
    let syncs = 0;
    let release: (() => void) | null = null;
    const handler = createSourceChangeHandler({
      rootDir: root,
      mode: 'on',
      cache: countingCache(counter),
      discover: () => {
        discoveries += 1;
        return foundBinary;
      },
      sync: () => {
        syncs += 1;
        return new Promise<CartoRunResult>((resolve) => {
          release = () => {
            resolve({ ok: true, detail: 'synced' });
          };
        });
      },
    });
    handler();
    handler();
    handler();
    // Every change invalidates, but the two bursts landing while the first
    // sync is still running must not queue further spawns.
    expect(counter.invalidations).toBe(3);
    expect(syncs).toBe(1);
    (release as unknown as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // Finishing invalidates again, so the next review reads the fresh
    // container, and releases the single-flight guard.
    expect(counter.invalidations).toBe(4);
    handler();
    expect(syncs).toBe(2);
    expect(discoveries).toBe(1);
  });

  it('keeps invalidating after carto turns out to be unavailable', () => {
    mkdirSync(join(root, '.carto'), { recursive: true });
    const counter = { invalidations: 0 };
    let syncs = 0;
    const handler = createSourceChangeHandler({
      rootDir: root,
      mode: 'on',
      cache: countingCache(counter),
      discover: () => ({ ok: false, reason: 'not-found', detail: 'absent' }),
      sync: () => {
        syncs += 1;
        return Promise.resolve({ ok: true, detail: 'synced' });
      },
    });
    handler();
    handler();
    expect(counter.invalidations).toBe(2);
    expect(syncs).toBe(0);
  });

  it('releases the single-flight guard when sync rejects', async () => {
    mkdirSync(join(root, '.carto'), { recursive: true });
    const counter = { invalidations: 0 };
    let syncs = 0;
    let reject: ((err: Error) => void) | null = null;
    const handler = createSourceChangeHandler({
      rootDir: root,
      mode: 'on',
      cache: countingCache(counter),
      discover: () => foundBinary,
      sync: () => {
        syncs += 1;
        return new Promise<CartoRunResult>((_resolve, rej) => {
          reject = rej;
        });
      },
    });
    handler();
    expect(syncs).toBe(1);
    (reject as unknown as (err: Error) => void)(
      new Error('carto sync blew up')
    );
    // Flush the rejected promise's .catch/.finally reactions before asserting.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // If inFlight were never reset on rejection, this second change would be
    // dropped and syncs would stay at 1 for the rest of the daemon's life.
    handler();
    expect(syncs).toBe(2);
  });
});
