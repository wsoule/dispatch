import { describe, expect, it } from 'bun:test';

import { queryTerms, relevanceTerms } from '../src/query.js';

describe('relevanceTerms', () => {
  it('takes lowercase words of 3+ characters from title, write paths and body, minus stopwords', () => {
    expect(
      relevanceTerms({
        title: 'Fix the PNPM allowBuilds',
        body: 'and so on',
        writes: ['packages/core/src/config.ts'],
      })
    ).toEqual([
      'fix',
      'pnpm',
      'allowbuilds',
      'packages',
      'core',
      'src',
      'config',
    ]);
  });

  it('never lets FTS syntax through (Review Focus 3)', () => {
    const terms = relevanceTerms({
      title: '"quoted" NEAR(a b) prefix* -not col:umn AND OR',
      body: '^start {x}',
      writes: [],
    });
    for (const term of terms) expect(term).toMatch(/^[\p{L}\p{N}_]+$/u);
  });

  it('keeps at most 32 distinct terms and reads only the first 1,000 bytes of the body', () => {
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
    expect(queryTerms(words)).toHaveLength(32);
    expect(
      relevanceTerms({ title: '', body: `${'x '.repeat(600)}tail`, writes: [] })
    ).not.toContain('tail');
    expect(queryTerms('Repeat repeat REPEAT')).toEqual(['repeat']);
  });
});
