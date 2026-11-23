#!/usr/bin/env bun
// Writes apps/mobile/src/theme.gen.ts from the desktop's design tokens in
// packages/ui/src/styles/tokens.css, so the phone has no colours of its own:
// change a token on desktop, run `moon run mobile:theme`, and the phone
// follows. test/theme.test.ts fails when the checked-in file is stale.
//
// React Native has no CSS variables or color-mix(), so every token is
// resolved here to a literal: var() chains are followed, and
// color-mix(in srgb, <colour> N%, transparent | <colour>) becomes an rgba()
// or a hex. Only the tokens the phone uses are written.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const TOKENS_PATH = resolve(
  here,
  '../../../packages/ui/src/styles/tokens.css'
);
export const OUTPUT_PATH = resolve(here, '../src/theme.gen.ts');

/** The tokens the phone reads, by their CSS name without the leading `--`. */
const COLOURS = [
  'bg',
  'bg-side',
  'surface',
  'surface-2',
  'surface-3',
  'sunken',
  'overlay',
  'border',
  'border-strong',
  'divider',
  'control-border',
  'text',
  'text-2',
  'text-3',
  'text-4',
  'text-inv',
  'accent',
  'on-accent',
  'accent-ink',
  'accent-soft',
  'accent-line',
  'red',
  'amber',
  'green',
  'blue',
  'gray',
  'red-soft',
  'amber-soft',
  'green-soft',
  'blue-soft',
  'red-line',
  'amber-line',
  'green-line',
  'blue-line',
  'on-red',
] as const;

const RADII = ['r-xs', 'r-chip', 'r-sm', 'r', 'r-lg', 'r-xl'] as const;

type Declarations = Map<string, string>;

/** The `--name: value;` pairs inside the first `{…}` after `selectorStart`. */
function block(css: string, selectorStart: string): Declarations {
  const at = css.indexOf(selectorStart);
  if (at === -1)
    throw new Error(`tokens.css has no block for ${selectorStart}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Declarations = new Map();
  for (const match of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined)
      out.set(name, value.replace(/\s+/g, ' ').trim());
  }
  return out;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

const toHex = (rgb: number[]) =>
  `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

/** A token's value as a literal React Native accepts: hex or rgba(). */
function resolveValue(
  value: string,
  tokens: Declarations,
  seen: string[] = []
): string {
  const v = value.trim();
  const ref = /^var\(--([\w-]+)\)$/.exec(v);
  if (ref?.[1] !== undefined) {
    const name = ref[1];
    if (seen.includes(name)) throw new Error(`token cycle at --${name}`);
    const next = tokens.get(name);
    if (next === undefined) throw new Error(`unknown token --${name}`);
    return resolveValue(next, tokens, [...seen, name]);
  }
  const mix =
    /^color-mix\(in srgb, (.+?) (\d+(?:\.\d+)?)%, (transparent|.+)\)$/.exec(v);
  if (mix !== null) {
    const [, colour = '', pct = '0', other = ''] = mix;
    const share = Number(pct) / 100;
    const rgb = hexToRgb(resolveValue(colour, tokens, seen));
    if (other === 'transparent')
      return `rgba(${rgb.join(', ')}, ${Number(share.toFixed(3))})`;
    const base = hexToRgb(resolveValue(other, tokens, seen));
    return toHex(rgb.map((c, i) => c * share + (base[i] ?? 0) * (1 - share)));
  }
  if (/^#[0-9a-f]{3,8}$/i.test(v) || /^rgba?\(/.test(v)) return v.toLowerCase();
  throw new Error(`cannot resolve token value: ${v}`);
}

const camel = (name: string) =>
  name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

/** The source text of theme.gen.ts for the given tokens.css contents. */
export function generateTheme(css: string): string {
  const light = block(css, ':root:where(:not([data-bt-ui-scoped]))');
  // Dark redefines only some tokens; the rest (the accent fill, the tints'
  // recipes) carry over from light and resolve against dark's hues.
  const dark: Declarations = new Map([
    ...light,
    ...block(css, "html[data-theme='dark']"),
  ]);
  const palette = (tokens: Declarations) =>
    COLOURS.map(
      (name) =>
        `  ${camel(name)}: '${resolveValue(tokens.get(name) ?? '', tokens)}',`
    ).join('\n');
  const radii = RADII.map((name) => {
    const px = /^(\d+)px$/.exec(light.get(name) ?? '');
    if (px?.[1] === undefined) throw new Error(`--${name} is not in px`);
    // --r-sm → sm, and the plain --r → md.
    return `  ${name === 'r' ? 'md' : name.slice(2)}: ${px[1]},`;
  }).join('\n');
  return `// Generated by apps/mobile/scripts/theme.ts from
// packages/ui/src/styles/tokens.css. Do not edit by hand: change the desktop
// token and run \`moon run mobile:theme\`.

export const light = {
${palette(light)}
} as const;

export const dark = {
${palette(dark)}
} as const;

export type Colours = { readonly [K in keyof typeof light]: string };

export const radius = {
${radii}
} as const;
`;
}

if (import.meta.main) {
  writeFileSync(OUTPUT_PATH, generateTheme(readFileSync(TOKENS_PATH, 'utf8')));
  console.log(`wrote ${OUTPUT_PATH}`);
}
