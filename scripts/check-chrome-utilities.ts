#!/usr/bin/env bun
import { Glob } from 'bun';

// Container chrome is the private vocabulary of src/ui/chrome; views compose the
// primitives instead of respelling a panel, as 85 hand-rolled containers did.
const BANNED = [
  'rounded-sm',
  'rounded-md',
  'rounded-lg',
  'rounded-xl',
  'shadow-hairline',
  'shadow-hairline-strong',
  'bg-card',
  'text-muted-foreground',
];

// Tailwind's stock colour scales. The app's own semantic colours (`text-green`,
// `bg-state-failed`, …) carry no numeric shade, so requiring one below keeps
// them out of this rule while catching `text-emerald-400` and friends.
const HUE_SCALES = [
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
];

const HUE_PROPERTIES = [
  'text',
  'bg',
  'border',
  'ring',
  'ring-offset',
  'fill',
  'stroke',
  'from',
  'via',
  'to',
  'divide',
  'outline',
  'decoration',
  'shadow',
  'accent',
  'caret',
  'placeholder',
];

const RAW_HUE = new RegExp(
  `(?<![\\w-])(?:${HUE_PROPERTIES.join('|')})-(?:${HUE_SCALES.join('|')})-\\d{2,3}(?![\\w-])`,
  'g'
);

// src/ui/ — the chrome primitives and the shadcn bases under them — is where
// these utilities legitimately live. `includes`, not `startsWith`, so it matches
// whatever workspace prefix the caller globbed from.
const EXEMPT = ['src/ui/'];

export interface Violation {
  path: string;
  utility: string;
}

/** Scans already-read files so the rule itself stays testable without disk IO. */
export function findViolations(
  files: ReadonlyArray<{ path: string; text: string }>
): Violation[] {
  const found: Violation[] = [];
  for (const file of files) {
    if (EXEMPT.some((prefix) => file.path.includes(prefix))) continue;
    for (const utility of BANNED) {
      // Word boundaries so `not-rounded-md-thing` misses, and so `shadow-hairline`
      // doesn't also fire inside `shadow-hairline-strong`.
      if (new RegExp(`(?<![\\w-])${utility}(?![\\w-])`).test(file.text)) {
        found.push({ path: file.path, utility });
      }
    }
    // One row per distinct hue utility, matching how the container rule reports:
    // a file that says `text-emerald-400` four times is one thing to fix.
    for (const utility of new Set(file.text.match(RAW_HUE) ?? [])) {
      found.push({ path: file.path, utility });
    }
  }
  return found;
}

if (import.meta.main) {
  const files: Array<{ path: string; text: string }> = [];
  for await (const path of new Glob('apps/desktop/src/**/*.{ts,tsx}').scan(
    '.'
  )) {
    files.push({ path, text: await Bun.file(path).text() });
  }
  const violations = findViolations(files);
  const enforce = process.argv.includes('--enforce');

  for (const violation of violations) {
    console.log(`${violation.path}: ${violation.utility}`);
  }
  console.log(
    `${violations.length} chrome-utility violation(s)${enforce ? '' : ' (reporting only)'}`
  );
  if (enforce && violations.length > 0) process.exit(1);
}
