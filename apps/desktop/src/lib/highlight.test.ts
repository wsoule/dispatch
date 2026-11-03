import { describe, expect, it } from 'bun:test';

import { runsFromNeedle } from './highlight';

// The text a run-splitter is given back unchanged, whatever it did in between.
function rejoin(runs: { text: string }[]): string {
  return runs.map((run) => run.text).join('');
}

describe('runsFromNeedle', () => {
  it('marks every occurrence', () => {
    expect(runsFromNeedle('a b a', 'a')).toEqual([
      { text: 'a', hit: true },
      { text: ' b ', hit: false },
      { text: 'a', hit: true },
    ]);
  });

  it('ignores case while preserving it in the output', () => {
    const runs = runsFromNeedle('Hello HELLO', 'hello');
    expect(runs.filter((run) => run.hit).map((run) => run.text)).toEqual([
      'Hello',
      'HELLO',
    ]);
  });

  it('highlights nothing for an empty needle', () => {
    expect(runsFromNeedle('abc', '')).toEqual([{ text: 'abc', hit: false }]);
  });

  it('is one plain run when there is no match', () => {
    expect(runsFromNeedle('abc', 'zz')).toEqual([{ text: 'abc', hit: false }]);
  });

  it('never loses or duplicates text', () => {
    const text = 'the quick brown fox';
    expect(rejoin(runsFromNeedle(text, 'o'))).toBe(text);
  });
});
