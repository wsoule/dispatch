#!/usr/bin/env bun
import { Glob } from 'bun';

// Container chrome is the private vocabulary of src/ui/chrome. Views and domain
// components compose those primitives instead of respelling a panel, which is
// what let 85 hand-rolled containers drift apart before the layer existed.
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

// Everything under src/ui/ — the chrome primitives themselves plus the
// shadcn-style base components they're built from — legitimately spells out
// these utilities. `includes` (not `startsWith`) matches this substring
// regardless of the workspace prefix the caller globbed from (e.g.
// `apps/desktop/src/ui/chrome/panel.tsx`).
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
      // Word boundaries so `not-rounded-md-thing` is not a hit, and so a
      // shorter banned utility doesn't also fire inside a longer one that
      // shares its prefix (e.g. `shadow-hairline` inside
      // `shadow-hairline-strong`).
      if (new RegExp(`(?<![\\w-])${utility}(?![\\w-])`).test(file.text)) {
        found.push({ path: file.path, utility });
      }
    }
  }
  return found;
}

if (import.meta.main) {
  const files: Array<{ path: string; text: string }> = [];
  for await (const path of new Glob('apps/desktop/src/**/*.tsx').scan('.')) {
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
