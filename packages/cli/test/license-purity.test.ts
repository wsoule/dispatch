import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// @dispatch/cli is MIT; @dispatch/server (the daemon) is FSL. The MIT grant
// only holds if the published artifact carries no server code, so server is a
// devDependency and the daemon is reached by SPAWNING it (commands/daemon.ts),
// never by import. Nothing else enforced that: with server out of
// `dependencies`, tsdown would silently bundle a careless src import into the
// artifact instead of externalizing it. This test pins the invariant. The one
// sanctioned reference — resolving '@dispatch/server/package.json' to locate
// the daemon entry in a checkout — is a string argument, not an import
// statement, so it does not trip the scan.

const PKG = resolve(import.meta.dir, '..');
const SRC = join(PKG, 'src');

// Same statement shapes browserPurity.test.ts scans in core: `import/export
// ... from 'x'` plus bare side-effect `import 'x'`. Type-only imports are
// counted too — they are erased from the bundle, but they still re-create the
// compile-time dependency the split removed.
const FROM_STATEMENT = /(?:^|\n)(?:import|export)\s+[\s\S]*?from\s+'([^']+)'/g;
const SIDE_EFFECT_IMPORT = /(?:^|\n)import\s+'([^']+)'/g;

function tsFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...tsFilesUnder(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

describe('license purity (MIT surface must not depend on the FSL server)', () => {
  it('no src module imports @dispatch/server', () => {
    const offenders: { file: string; specifier: string }[] = [];
    for (const file of tsFilesUnder(SRC)) {
      const source = readFileSync(file, 'utf8');
      const specifiers = [
        ...[...source.matchAll(FROM_STATEMENT)].map((m) => m[1]),
        ...[...source.matchAll(SIDE_EFFECT_IMPORT)].map((m) => m[1]),
      ];
      for (const specifier of specifiers) {
        if (
          specifier === '@dispatch/server' ||
          specifier.startsWith('@dispatch/server/')
        ) {
          offenders.push({ file: relative(SRC, file), specifier });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('package.json does not list @dispatch/server as a runtime dependency', () => {
    const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain(
      '@dispatch/server'
    );
  });
});
