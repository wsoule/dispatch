import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const SRC = join(import.meta.dir, '../src');
const transpiler = new Bun.Transpiler({ loader: 'ts' });

// Every source file and bare specifier reachable from `entry` through runtime
// imports; type-only imports are erased, so they never count.
function reachable(entry: string): { files: string[]; bare: string[] } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i];
    if (file === undefined || files.has(file)) continue;
    files.add(file);
    for (const { path } of transpiler.scanImports(readFileSync(file, 'utf8'))) {
      if (path.startsWith('.'))
        queue.push(join(dirname(file), path.replace(/\.js$/, '.ts')));
      else bare.add(path);
    }
  }
  return { files: [...files], bare: [...bare] };
}

describe('the package root entry', () => {
  it('never reaches the federation subpath or node:crypto', () => {
    const { files, bare } = reachable(join(SRC, 'index.ts'));
    const inSrc = files.map((f) => relative(SRC, f));
    expect(inSrc).toContain('engine.ts');
    expect(inSrc.filter((f) => f.startsWith('federation'))).toEqual([]);
    expect(bare.filter((s) => s.replace(/^node:/, '') === 'crypto')).toEqual(
      []
    );
  });
});
