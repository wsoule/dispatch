import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// `@dispatch/core/browser` is imported by the desktop webview, where a `node:`
// builtin is a build failure rather than a runtime one. Nothing enforced that
// before: the entry point stayed pure by convention, and the SQLite backend
// (node:sqlite) is exactly the kind of addition that could reach it by way of
// one careless value re-export from index-adjacent code.
//
// This walks the real value-import graph from browser.ts. Type-only imports
// and exports are skipped because they are erased at build time — which is why
// browser.ts can already re-export CreateInput from the node:fs-backed
// store.ts without pulling any of it into the bundle.

const SRC = resolve(import.meta.dir, '..', 'src');

// `import ...  from 'x'` / `export ... from 'x'`, with the clause captured so a
// `type`-prefixed one can be dropped, plus bare side-effect `import 'x'`.
const FROM_STATEMENT =
  /(?:^|\n)(?:import|export)\s+([\s\S]*?)\s*from\s+'([^']+)'/g;
const SIDE_EFFECT_IMPORT = /(?:^|\n)import\s+'([^']+)'/g;

// Every module a value import can reach from `entry`, as paths relative to
// src/, along with the runtime-builtin specifiers found on the way. Both
// `node:` and `bun:` count: neither exists in a browser bundle, and a `bun:`
// one is additionally fatal to the Node-run CLI.
function valueGraph(entry: string): {
  visited: Set<string>;
  builtins: { file: string; specifier: string }[];
} {
  const visited = new Set<string>();
  const builtins: { file: string; specifier: string }[] = [];
  const queue = [resolve(SRC, entry)];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const key = relative(SRC, file);
    if (visited.has(key)) continue;
    visited.add(key);
    const source = readFileSync(file, 'utf8');
    const specifiers: string[] = [];
    for (const [, clause, specifier] of source.matchAll(FROM_STATEMENT)) {
      if (/^type\b/.test(clause)) continue;
      specifiers.push(specifier);
    }
    for (const [, specifier] of source.matchAll(SIDE_EFFECT_IMPORT)) {
      specifiers.push(specifier);
    }
    for (const specifier of specifiers) {
      if (specifier.startsWith('node:') || specifier.startsWith('bun:')) {
        builtins.push({ file: key, specifier });
      } else if (specifier.startsWith('.')) {
        queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
      }
    }
  }
  return { visited, builtins };
}

describe('browser entry point purity', () => {
  it('reaches no node: or bun: builtin from browser.ts', () => {
    expect(valueGraph('browser.ts').builtins).toEqual([]);
  });

  it('never reaches the SQLite modules from browser.ts', () => {
    const { visited } = valueGraph('browser.ts');
    expect(
      [...visited].filter((f) => f.toLowerCase().includes('sqlite'))
    ).toEqual([]);
    expect(visited.has('storeBackend.ts')).toBe(false);
  });

  // Proves the walker is actually following imports rather than finding
  // nothing because it parsed nothing: the node-side entry really does reach
  // the sqlite modules and real builtins through them.
  it('does reach the sqlite modules and node builtins from the node entry', () => {
    const { visited, builtins } = valueGraph('index.ts');
    expect(visited.has('sqliteTaskStore.ts')).toBe(true);
    expect(visited.has('sqliteDb.ts')).toBe(true);
    expect(builtins.map((b) => b.specifier)).toContain('node:fs');
  });

  /**
   * NEITHER SQLite driver may be a static value import anywhere reachable from
   * the node barrel, even though sqliteDb.ts is. They are loaded through
   * createRequire at first use, and each would break a different runtime if
   * that changed:
   *
   * - `node:sqlite` only became available unflagged in Node 22.13, and
   *   `@dispatch/cli` declares `node: >=22` and imports this barrel for every
   *   command. A top-level import would throw ERR_UNKNOWN_BUILTIN_MODULE
   *   during module evaluation on 22.0–22.12, killing `dispatch task list` on
   *   a plain file-backed project that never wanted a database at all.
   * - `bun:sqlite` does not exist under Node at all, so a top-level import
   *   would kill every CLI command outright on the runtime the CLI targets.
   *
   * Reinstating either import would look completely harmless, which is why
   * this is pinned rather than left to review.
   */
  it('never reaches a sqlite driver as an eager import from the node entry', () => {
    const specifiers = valueGraph('index.ts').builtins.map((b) => b.specifier);
    expect(specifiers).not.toContain('node:sqlite');
    expect(specifiers).not.toContain('bun:sqlite');
  });

  // browser.ts re-exports store.ts's input types; if that ever stops being a
  // type-only export the first test fires, so pin the arrangement it relies on.
  it('re-exports store types without importing store.ts', () => {
    const browser = readFileSync(join(SRC, 'browser.ts'), 'utf8');
    expect(browser).toContain("} from './store.js';");
    expect(browser).toMatch(/export type \{[^}]*\n\} from '\.\/store\.js';/);
  });
});
