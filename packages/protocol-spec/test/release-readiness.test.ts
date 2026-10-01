import { expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { SPEC_DIR } from '../src/sections.js';

const files = readdirSync(SPEC_DIR).filter(
  (f) => f.endsWith('.md') && !f.startsWith('.')
);
// Flattened, so a mark the formatter wrapped across lines still matches.
const all = files
  .map((f) => readFileSync(new URL(f, SPEC_DIR), 'utf8'))
  .join('\n')
  .replace(/\s+/g, ' ');
const readme = readFileSync(
  new URL('../README.md', import.meta.url),
  'utf8'
).replace(/\s+/g, ' ');

it('has no skeleton placeholder or stub left', () => {
  for (const f of files) {
    const text = readFileSync(new URL(f, SPEC_DIR), 'utf8');
    expect({
      f,
      placeholder: /Written in Task \d|lands in a later draft/.test(text),
    }).toEqual({
      f,
      placeholder: false,
    });
  }
});

it('marks all sixteen pinned rules', () => {
  const marked = new Set(
    [...all.matchAll(/\(pinned rule (\d+); vectors:/g)].map((m) => Number(m[1]))
  );
  expect([...marked].sort((a, b) => a - b)).toEqual(
    Array.from({ length: 16 }, (_, i) => i + 1)
  );
});

// The foreign `@dispatch` npm scope is not ours: name only published packages.
it('names no package in the foreign @dispatch scope', () => {
  expect([...all.matchAll(/@dispatch\/[a-z0-9-]+/g)].map((m) => m[0])).toEqual(
    []
  );
});

const CLAIM_NAMES: Record<string, string> = {
  Core: 'core',
  'Dispatch profile': 'dispatch-profile',
  'A2A binding': 'a2a-binding',
};

// Each "implements DMP <v> (<claims>)" sentence is backed by the reports it
// links: every claim it quotes is a pass in one of them, measured against <v>.
it('backs every claim the known implementations quote with a linked passing report', () => {
  const sentences = [...readme.matchAll(/implements DMP (\S+) \(([^)]+)\)/g)];
  expect(sentences.length).toBeGreaterThan(0);
  // A link to a report in this package, relative or on the repository's main.
  const reports = [
    ...readme.matchAll(
      /\]\((?:https:\/\/github\.com\/wsoule\/dispatch\/blob\/main\/packages\/protocol-spec\/)?(reports\/[^)\s]+\.json)\)/g
    ),
  ].map((m) => m[1] ?? '');
  expect(reports.length).toBeGreaterThan(0);
  const read = reports.map((path) => {
    const url = new URL(`../${path}`, import.meta.url);
    expect({ path, exists: existsSync(url) }).toEqual({ path, exists: true });
    return JSON.parse(readFileSync(url, 'utf8')) as {
      dmp: string;
      claims: Record<string, string>;
    };
  });
  for (const [, version, quoted] of sentences) {
    for (const name of (quoted ?? '').split(', ')) {
      const claim = CLAIM_NAMES[name] ?? name;
      const backed = read.some(
        (r) => r.dmp === version && r.claims[claim] === 'pass'
      );
      expect({ version, claim, backed }).toEqual({
        version,
        claim,
        backed: true,
      });
    }
  }
});
