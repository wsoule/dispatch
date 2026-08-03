import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildDepMap,
  DepMapCache,
  depMapSourceDirs,
  isSkippedPath,
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
