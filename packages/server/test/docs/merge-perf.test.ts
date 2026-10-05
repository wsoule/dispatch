import { describe, expect, it } from 'bun:test';

import { DIFF_WORK, diffLines, merge3 } from '../../src/docs/merge.js';
import { corpusLines, reshape, SHAPES } from './corpus.js';

const IDS = { head: 'rev-A', base: 'rev-O', mine: 'rev-B' };

describe('review focus 2: merge at the cap stays bounded for all six shapes', () => {
  const base = corpusLines();
  const baseText = base.join('');

  it('builds a corpus near 768 KiB', () => {
    const bytes = Buffer.byteLength(baseText);
    expect(bytes).toBeLessThanOrEqual(768 * 1024);
    expect(bytes).toBeGreaterThan(760 * 1024);
  });

  for (const shape of SHAPES) {
    it(`${shape}: a valid diff within DIFF_WORK, the same work twice, and a merge under 500 ms`, () => {
      const changed = reshape(base, shape);
      const first = diffLines(base, changed);
      const second = diffLines(base, changed);
      expect(first.work).toBeLessThanOrEqual(DIFF_WORK + 1);
      expect(second.work).toBe(first.work);
      expect(second.matches).toEqual(first.matches);
      for (const [i, j] of first.matches) expect(base[i]).toBe(changed[j]);

      const mine = [...base];
      mine[1] = mine[1].replace('\n', ' mine\n');
      const started = performance.now();
      const merged = merge3(baseText, changed.join(''), mine.join(''), IDS);
      const ms = performance.now() - started;
      expect(ms).toBeLessThan(500);
      if (merged.clean)
        expect(Buffer.byteLength(merged.body)).toBeLessThan(900 * 1024);
    });
  }

  it('merges a cap-sized body of blank lines, clean or conflicted', () => {
    const blank = '\n'.repeat(768 * 1024);
    expect(merge3(blank, `${blank}x\n`, blank, IDS)).toEqual({
      clean: true,
      body: `${blank}x\n`,
      spent: false,
    });
    const conflicted = merge3('a\n', blank, 'b\n', IDS);
    expect(conflicted.clean).toBe(false);
    if (conflicted.clean) return;
    expect(conflicted.hunks[0].head.length).toBe(768 * 1024);
    expect(
      conflicted.marked.startsWith(`<<<<<<< rev-A\n${blank}||||||| rev-O\na\n`)
    ).toBe(true);
  });
});
