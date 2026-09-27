import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { loadVectors } from '../src/load.js';
import { sectionsOf, SPEC_DIR } from '../src/sections.js';

const files = readdirSync(SPEC_DIR).filter(
  (f) => f.endsWith('.md') && !f.startsWith('.')
);
const text = new Map(
  files.map((f) => [f, readFileSync(new URL(f, SPEC_DIR), 'utf8')])
);
// The spec's prose as one line per file, so a phrase the formatter wrapped
// across lines still matches.
const flat = (body: string): string => body.replace(/\s+/g, ' ');
const all = flat([...text.values()].join('\n'));
const ids = new Set(loadVectors().vectors.map((v) => v.id));

describe('the DMP text', () => {
  it('states BCP 14 in 1.4', () => {
    const conventions = flat(text.get('01-introduction.md') ?? '');
    expect(conventions).toContain('BCP 14');
    expect(conventions).toContain(
      'when, and only when, they appear in all capitals'
    );
  });

  it('cites only vectors that exist', () => {
    for (const m of all.matchAll(
      /`((?:env|core|a2a|fed)\.[a-z0-9-]+\.[a-z0-9-]+)`/g
    )) {
      expect({ id: m[1], exists: ids.has(m[1] ?? '') }).toEqual({
        id: m[1],
        exists: true,
      });
    }
  });

  it('marks each pinned rule 1 to 16', () => {
    const marked = new Set(
      [...all.matchAll(/\(pinned rule (\d+)[;)]/g)].map((m) => m[1])
    );
    for (let n = 1; n <= 16; n += 1)
      expect({ rule: n, marked: marked.has(String(n)) }).toEqual({
        rule: n,
        marked: true,
      });
  });

  it('marks pinned rules with at least one vector', () => {
    for (const m of all.matchAll(/\(pinned rule (\d+); vectors: ([^)]*)\)/g)) {
      const cited = [...(m[2] ?? '').matchAll(/`([^`]+)`/g)].map((c) => c[1]);
      expect({ rule: m[1], cited: cited.length > 0 }).toEqual({
        rule: m[1],
        cited: true,
      });
    }
  });

  it('links only to files and section anchors that exist', () => {
    for (const [file, body] of text) {
      for (const m of body.matchAll(
        /\]\(([^)#\s]+\.md)(?:#s([0-9A-F.]+))?\)/g
      )) {
        const target = m[1] ?? '';
        expect({
          file,
          target,
          exists: existsSync(new URL(target, SPEC_DIR)),
        }).toEqual({ file, target, exists: true });
        if (m[2] !== undefined)
          expect(sectionsOf(text.get(target) ?? '')).toContain(m[2]);
      }
    }
  });

  // The site rewrites exactly these links to /protocol/<version>/#s<n>; any
  // other .md link would 404 there.
  it('links to .md files only by a spec file name the site can rewrite', () => {
    for (const [file, body] of text) {
      for (const m of body.matchAll(/\]\(([^)\s]*\.md)(#[^)\s]*)?\)/g)) {
        const target = m[1] ?? '';
        expect({
          file,
          target,
          ok: /^(?:[0-9]{2}-[a-z0-9-]+|appendix-[a-f]-[a-z0-9-]+)\.md$/.test(
            target
          ),
        }).toEqual({ file, target, ok: true });
      }
    }
  });
});
