import { cutUtf8 } from './limits.js';

const WORD = /[\p{L}\p{N}_]+/gu;

// A fixed list of English stopwords; terms are only for ranking, never for exact recall.
export const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'onto',
  'when',
  'then',
  'than',
  'have',
  'has',
  'had',
  'are',
  'was',
  'were',
  'will',
  'would',
  'should',
  'could',
  'can',
  'not',
  'but',
  'all',
  'any',
  'each',
  'only',
  'also',
  'its',
  'our',
  'your',
  'their',
  'there',
  'here',
  'what',
  'which',
  'who',
  'how',
  'why',
  'use',
  'using',
  'used',
  'via',
  'per',
  'out',
  'off',
  'one',
  'two',
  'too',
  'very',
  'more',
  'most',
  'some',
  'such',
  'these',
  'those',
  'them',
  'they',
  'she',
  'him',
  'her',
  'his',
  'you',
  'yet',
  'just',
  'over',
  'under',
  'about',
  'after',
  'before',
]);

/** Lowercase words of at least 3 characters, minus stopwords, first-seen order, at most `max`. */
export function queryTerms(text: string, max = 32): string[] {
  const out: string[] = [];
  for (const match of text.toLowerCase().matchAll(WORD)) {
    const word = match[0];
    if (
      Array.from(word).length < 3 ||
      STOPWORDS.has(word) ||
      out.includes(word)
    )
      continue;
    out.push(word);
    if (out.length === max) break;
  }
  return out;
}

// The index's relevance query: title, write-path segments and the body's first 1,000 bytes.
export function relevanceTerms(ctx: {
  title: string;
  body: string;
  writes: readonly string[];
}): string[] {
  const segments = ctx.writes.flatMap((w) => w.split('/'));
  return queryTerms(
    [ctx.title, ...segments, cutUtf8(ctx.body, 1000)].join(' ')
  );
}
