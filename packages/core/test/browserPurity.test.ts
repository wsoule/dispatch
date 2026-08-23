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
// src/, along with the `node:` specifiers found on the way.
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
      if (specifier.startsWith('node:')) {
        builtins.push({ file: key, specifier });
      } else if (specifier.startsWith('.')) {
        queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
      }
    }
  }
  return { visited, builtins };
}

describe('browser entry point purity', () => {
  it('reaches no node: builtin from browser.ts', () => {
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
  // nothing because it parsed nothing: the node-side entry does reach both.
  it('does reach node:sqlite from the node entry point', () => {
    const { visited, builtins } = valueGraph('index.ts');
    expect(visited.has('sqliteTaskStore.ts')).toBe(true);
    expect(builtins.map((b) => b.specifier)).toContain('node:sqlite');
  });

  // browser.ts re-exports store.ts's input types; if that ever stops being a
  // type-only export the first test fires, so pin the arrangement it relies on.
  it('re-exports store types without importing store.ts', () => {
    const browser = readFileSync(join(SRC, 'browser.ts'), 'utf8');
    expect(browser).toContain("} from './store.js';");
    expect(browser).toMatch(/export type \{[^}]*\n\} from '\.\/store\.js';/);
  });
});
