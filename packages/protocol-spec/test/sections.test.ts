import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

import { listSections, sectionsOf, SPEC_DIR } from '../src/sections.js';
import { OUTLINE } from './outline.js';

// The outline's headings, in order, as a subsequence of the file's headings.
function headingsOf(file: string): string[] {
  return readFileSync(new URL(file, SPEC_DIR), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('#'));
}

describe('the spec skeleton', () => {
  it('has exactly the outline files', () => {
    const files = readdirSync(SPEC_DIR)
      .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
      .sort();
    expect(files).toEqual(OUTLINE.map((o) => o.file).sort());
  });

  for (const { file, headings } of OUTLINE) {
    it(`${file} carries every outline heading in order`, () => {
      const found = headingsOf(file);
      let at = 0;
      for (const h of headings) {
        const next = found.indexOf(h, at);
        expect({ file, heading: h, found: next !== -1 }).toEqual({
          file,
          heading: h,
          found: true,
        });
        at = next + 1;
      }
    });
  }

  it('numbers sections and appendix subsections', () => {
    expect(
      sectionsOf('# 6 Delivery\n\n## 6.2 Mode selection\n\n### Notes\n')
    ).toEqual(['6', '6.2']);
    expect(
      sectionsOf('# Appendix C Dispatch profile\n\n## C.3 Gate types\n')
    ).toEqual(['C', 'C.3']);
    expect(sectionsOf('## A2A binding notes\n')).toEqual([]);
  });

  it('skips heading-like lines inside fenced code', () => {
    expect(
      sectionsOf('# 6 Delivery\n```sh\n# 6.1 a shell comment\n```\n## 6.2 X\n')
    ).toEqual(['6', '6.2']);
    // A fence closes only on its own character, at least as long.
    expect(
      sectionsOf('~~~~\n```\n## 6.1 A\n~~~\n## 6.2 B\n~~~~\n## 6.3 C\n')
    ).toEqual(['6.3']);
    // Backticks after the run make it inline code, not a fence.
    expect(sectionsOf('```a``` b\n## 6.1 A\n')).toEqual(['6.1']);
  });

  it('lists 5.9, 6.8, 9.3, 13.16 and C.3', () => {
    const all = new Set(listSections(SPEC_DIR));
    for (const n of ['5.9', '6.8', '9.3', '13.16', 'C.3', '11.11'])
      expect(all.has(n)).toBe(true);
  });
});
