import { describe, expect, test } from 'bun:test';

import { matchesQuery, nodeText } from './search';

describe('matchesQuery', () => {
  test('every word must appear, in any order and case', () => {
    expect(matchesQuery('spend run', 'Spend per run')).toBe(true);
    expect(matchesQuery('run spend', 'Spend per run')).toBe(true);
    expect(matchesQuery('spend day', 'Spend per run')).toBe(false);
  });

  test('matches inside words, so part of a word finds its setting', () => {
    expect(matchesQuery('hook', 'Webhook URL')).toBe(true);
  });
});

describe('nodeText', () => {
  test('reads the visible text out of nested JSX', () => {
    expect(
      nodeText(
        <>
          Add <code>sync</code> to {'config'} {3} times
        </>
      ).replace(/\s+/g, ' ')
    ).toBe('Add sync to config 3 times');
  });

  test('ignores empty and boolean children', () => {
    expect(nodeText([null, undefined, false, 'kept'])).toBe('   kept');
  });
});
