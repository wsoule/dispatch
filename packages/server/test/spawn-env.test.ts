import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// Bun hands a spawn with no `env` the process's STARTUP environment, which
// still holds a preset DISPATCH_APP_TOKEN after the daemon deletes it. So every
// spawn in the daemon's packages passes an env explicitly.

const PACKAGES = resolve(import.meta.dirname, '../..');
const SOURCES = ['server/src', 'core/src', 'cli/src', 'mcp/src'];
const CALL =
  /\b(?:Bun\.spawn(?:Sync)?|spawnSync|execFileSync|execFile|execSync|spawn)\(/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });
}

// The text of the call starting at `at`, up to its balanced closing paren.
function callText(source: string, at: number): string {
  let depth = 0;
  for (let i = source.indexOf('(', at); i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(at, i + 1);
  }
  return source.slice(at);
}

describe('child process environments', () => {
  it('every spawn passes an explicit env', () => {
    const missing: string[] = [];
    for (const dir of SOURCES) {
      for (const file of files(join(PACKAGES, dir))) {
        const source = readFileSync(file, 'utf8');
        for (const m of source.matchAll(CALL)) {
          const before = source.slice(Math.max(0, m.index - 9), m.index);
          if (/function\s*$|\.\s*$/.test(before) && !before.endsWith('Bun.'))
            continue;
          const line = source.slice(0, m.index).split('\n').length;
          const lineText = source.split('\n')[line - 1] ?? '';
          if (/^\s*(\/\/|\*)/.test(lineText)) continue;
          if (!/\benv\b/.test(callText(source, m.index)))
            missing.push(`${relative(PACKAGES, file)}:${line}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
