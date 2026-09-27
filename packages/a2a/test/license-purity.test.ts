import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const PKG = resolve(import.meta.dir, '..');
const SRC = join(PKG, 'src');
const SERVER = resolve(PKG, '..', 'server');
const FROM_STATEMENT = /(?:^|\n)(?:import|export)\s+[\s\S]*?from\s+'([^']+)'/g;
const SIDE_EFFECT_IMPORT = /(?:^|\n)import\s+'([^']+)'/g;
// MIT surface: no FSL daemon code, and not the SDK's server.
const FORBIDDEN_PACKAGES = [
  /^@dispatch\/server(\/|$)/,
  /^@a2a-js\/sdk\/server(\/|$)/,
  /^express$/,
];

function tsFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...tsFilesUnder(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

describe('license purity (@dispatch/a2a is MIT)', () => {
  it('no src module imports the daemon or the SDK server', () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(SRC)) {
      const source = readFileSync(file, 'utf8');
      const specifiers = [
        ...[...source.matchAll(FROM_STATEMENT)].map((m) => m[1]),
        ...[...source.matchAll(SIDE_EFFECT_IMPORT)].map((m) => m[1]),
      ];
      for (const spec of specifiers) {
        const intoServer =
          spec.startsWith('.') &&
          resolve(dirname(file), spec).startsWith(SERVER);
        if (intoServer || FORBIDDEN_PACKAGES.some((re) => re.test(spec))) {
          offenders.push(`${relative(PKG, file)} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
