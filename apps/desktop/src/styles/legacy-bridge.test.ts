import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// legacy-bridge.css aliases the token names the legacy views and packages/ui-legacy still read
// onto @dispatch/ui's Gr8r tokens. The old palette (packages/tokens) is no longer loaded, so a
// name the bridge forgets resolves to nothing and the element paints transparent or in the
// browser's defaults. This test reads every `var(--name)` in the desktop's source and the
// legacy library and checks that some sheet declares it: Gr8r's tokens.css, the bridge,
// tailwind.css's shadcn block, the other sheets here, or a file of the app itself (a component
// setting its own property inline, a CSS module declaring its own).

const srcDir = path.join(import.meta.dir, '..');
const repoRoot = path.join(srcDir, '..', '..', '..');

/** Every .css, .ts and .tsx file under a directory, comments stripped, tests left out (a test
    may quote a name on purpose). */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    if (!/\.(css|tsx?)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
      return [];
    }
    return [readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')];
  });
}

/** The Gr8r tokens, through the dependency: @dispatch/ui/styles.css is
    packages/ui/src/styles/index.css, next to tokens.css. */
const gr8rTokens = readFileSync(
  path.join(
    path.dirname(Bun.resolveSync('@dispatch/ui/styles.css', import.meta.dir)),
    'tokens.css'
  ),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

const bridge = readFileSync(
  path.join(import.meta.dir, 'legacy-bridge.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

/** The legacy code: this app's src/ and packages/ui-legacy/src, which the views import as
    `@/ui/*`. preflight.css is Tailwind's own and reads Tailwind's theme. */
const legacy = [
  ...sources(srcDir).filter((text) => !text.includes('::file-selector-button')),
  ...sources(path.join(repoRoot, 'packages', 'ui-legacy', 'src')),
];

/** Every `--name` a text declares, as a CSS declaration or an inline style key
    (`'--gap': spacing`). */
function declarations(text: string): string[] {
  return [...text.matchAll(/(?<![\w-])(--[\w-]+)['"]?\s*:/g)].map(
    (match) => match[1] ?? ''
  );
}

/** Every `--name` a text reads through `var()`. A template literal's open name
    (`var(--project-color-${n})`) is left out; the eight are checked by name below. */
function reads(text: string): string[] {
  return [...text.matchAll(/var\(\s*(--[\w-]+)/g)]
    .map((match) => match[1] ?? '')
    .filter((name) => !name.endsWith('-'));
}

/** Tailwind's own theme variables, emitted by its theme layer rather than any sheet here. */
const TAILWIND_OWN = ['--spacing'];

describe('legacy-bridge.css resolves every name the legacy code reads', () => {
  const declared = new Set([
    ...declarations(gr8rTokens),
    ...legacy.flatMap(declarations),
  ]);
  const read = new Set(legacy.flatMap(reads));

  test('the scan sees the legacy code and the Gr8r tokens', () => {
    expect(read.size).toBeGreaterThan(100);
    expect(declared.has('--surface')).toBe(true);
    expect(declared.has('--surface-quaternary')).toBe(true);
  });

  test('every custom property read resolves to a declaration', () => {
    const missing = [...read].filter(
      (name) => !declared.has(name) && !TAILWIND_OWN.includes(name)
    );
    expect(missing.sort()).toEqual([]);
  });

  test('the bridge declares nothing Gr8r declares, and no colour of its own', () => {
    const gr8r = new Set(declarations(gr8rTokens));
    expect(declarations(bridge).filter((name) => gr8r.has(name))).toEqual([]);
    expect(bridge).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  test('every alias in the bridge points at a Gr8r token or another alias', () => {
    const names = new Set([
      ...declarations(gr8rTokens),
      ...declarations(bridge),
    ]);
    expect(reads(bridge).filter((name) => !names.has(name))).toEqual([]);
  });

  test('the eight project colours and the run-state roles are all there', () => {
    const bridged = new Set(declarations(bridge));
    for (let n = 1; n <= 8; n++) {
      expect(bridged.has(`--project-color-${n}`)).toBe(true);
    }
    for (const state of [
      'working',
      'waiting',
      'failed',
      'review',
      'landing',
      'ready',
      'blocked',
    ]) {
      for (const part of ['fg', 'surface', 'edge']) {
        expect(bridged.has(`--state-${state}-${part}`)).toBe(true);
      }
    }
  });
});
