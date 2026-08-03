import type { CartoBlastRadius, CartoReader } from '@dispatch/core/carto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildDepMap,
  createCartoDepMap,
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
});
