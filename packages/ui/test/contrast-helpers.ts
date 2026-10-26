import { expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Shared helpers for the stylesheet contrast tests (styles-contrast,
// tasks-contrast, graph-contrast): the token blocks of tokens.css parsed
// into maps per theme, a resolver that follows var() aliases down to a
// literal hex, WCAG contrast arithmetic, tint compositing, rule lookup in
// a stylesheet, and the list of retired (pre-Gr8r) token names.

export const srcDir = path.join(import.meta.dir, '..', 'src');

/** A stylesheet's text with its comments removed. */
export function readCss(file: string): string {
  return readFileSync(path.join(srcDir, file), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  );
}

export const tokensCss = readCss('styles/tokens.css');

/** Every `--name: value` declaration of the rule whose selector starts so. */
function tokenBlock(selectorStart: string): Map<string, string> {
  const at = tokensCss.indexOf(selectorStart);
  expect(at).toBeGreaterThanOrEqual(0);
  const open = tokensCss.indexOf('{', at);
  const body = tokensCss.slice(open + 1, tokensCss.indexOf('}', open));
  const out = new Map<string, string>();
  for (const declaration of body.split(';')) {
    const match = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(declaration);
    if (match !== null) {
      out.set(match[1] ?? '', (match[2] ?? '').replace(/\s+/g, ' '));
    }
  }
  return out;
}

/** The light tokens (the bare :root block). */
export const lightTokens = tokenBlock(':root:where(:not([data-bt-ui-scoped]))');

/** The dark tokens: the light block overlaid by the dark one, as the
    cascade resolves them on <html data-theme="dark">. */
export const darkTokens = new Map([
  ...lightTokens,
  ...tokenBlock("html[data-theme='dark']"),
]);

export const THEMES = [
  ['light', lightTokens],
  ['dark', darkTokens],
] as const;

/** A token's hex value, following `var(--other)` aliases in the same
    theme; fails the test when it does not end in a literal hex. */
export function hex(tokens: Map<string, string>, name: string): string {
  let value = tokens.get(name);
  for (let hops = 0; value !== undefined && hops < 6; hops++) {
    const alias = /^var\((--[\w-]+)\)$/.exec(value);
    if (alias === null) break;
    value = tokens.get(alias[1] ?? '');
  }
  expect({ name, value }).toEqual({
    name,
    value: expect.stringMatching(/^#[0-9a-f]{6}$/i),
  });
  return (value ?? '').toLowerCase();
}

function channels(color: string): number[] {
  return [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));
}

export function luminance(color: string): number {
  const [r, g, b] = channels(color).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** `share` of `top` laid over `base`: what a color-mix(top N%, transparent)
    tint (or an element at that opacity) looks like on that surface. */
export function over(top: string, base: string, share: number): string {
  const a = channels(top);
  const b = channels(base);
  return `#${a
    .map((v, i) =>
      Math.round(v * share + (b[i] ?? 0) * (1 - share))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

/** The percentage of a `color-mix(in srgb, var(--hue) N%, transparent)`. */
export function tintShare(tokens: Map<string, string>, name: string): number {
  const match =
    /color-mix\(in srgb, var\(--[\w-]+\) (\d+)%, transparent\)/.exec(
      tokens.get(name) ?? ''
    );
  expect({ name, found: match !== null }).toEqual({ name, found: true });
  return Number(match?.[1] ?? 0) / 100;
}

/** The declarations of the first rule whose whole selector list is
    exactly `selector` in a stylesheet under src, whitespace collapsed
    (comments are already gone). A rule where `selector` is only one of
    several selectors, or the end of a longer one (`.label .cue` for
    `.cue`), does not count: the selector must start the sheet or follow a
    `{` or `}`. */
export function cssRule(file: string, selector: string): string {
  const sheet = readCss(file).replace(/\s+/g, ' ');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[{}]) ?${escaped} \\{`).exec(sheet);
  expect({ file, selector, found: match !== null }).toEqual({
    file,
    selector,
    found: true,
  });
  const open = sheet.indexOf('{', (match?.index ?? 0) + 1);
  return sheet.slice(open + 1, sheet.indexOf('}', open)).trim();
}

/** Every stylesheet and TypeScript source file under a directory. */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(css|tsx?)$/.test(entry.name) ? [full] : [];
  });
}

/** The pre-Gr8r token names (docs/architecture.md §8.2 "Old token
    names"): migration aliases in tokens.css while the screens moved to the
    Gr8r names, now removed. No file reads or declares any of them. */
export const RETIRED = [
  '--paper',
  '--ink',
  '--background',
  '--foreground',
  '--muted',
  '--ink-soft',
  '--grey',
  '--grey-2',
  '--grey-2-ink',
  '--grey-3',
  '--grey-4',
  '--tint',
  '--hairline-faint',
  '--hatch',
  '--red-ink',
  '--amber-ink',
  '--amber-ink-strong',
  '--green-ink',
  '--blue-ink',
  '--muted-inverse',
  '--ink-soft-inverse',
  '--hairline-inverse',
  '--ease-out-quint',
  '--ease-out-expo',
] as const;

/** "file: --name" for every retired token name a file reads or sets
    (comments ignored; the name as a whole custom property, so --muted
    does not match --muted-x). */
export function retiredNamesIn(files: readonly string[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const name of RETIRED) {
      if (new RegExp(`${name}(?![\\w-])`).test(source)) {
        found.push(`${path.relative(srcDir, file)}: ${name}`);
      }
    }
  }
  return found;
}
