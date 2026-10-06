import { describe, expect, it } from 'bun:test';

import {
  diffChunks,
  diffLines,
  merge3,
  MERGE_ALGO,
} from '../../src/docs/merge.js';
import { splitLines } from '../../src/docs/sections.js';
import { mulberry32 } from './corpus.js';

const LOCAL = {
  head: 'head (rev 13, human:wyat)',
  base: 'base (rev 12)',
  mine: 'yours',
};

// Every match pairs equal lines, strictly increasing on both sides.
function assertValid(
  a: string[],
  b: string[],
  matches: Array<[number, number]>
): void {
  let pi = -1;
  let pj = -1;
  for (const [i, j] of matches) {
    expect(i).toBeGreaterThan(pi);
    expect(j).toBeGreaterThan(pj);
    expect(a[i]).toBe(b[j]);
    pi = i;
    pj = j;
  }
}

describe('diffLines', () => {
  it('matches common lines and leaves changes unmatched', () => {
    const a = splitLines('a\nb\nc\nd\n');
    const b = splitLines('a\nx\nc\nd\ne\n');
    const d = diffLines(a, b);
    assertValid(a, b, d.matches);
    expect(d.matches).toEqual([
      [0, 0],
      [2, 2],
      [3, 3],
    ]);
    expect(d.spent).toBe(false);
  });

  it('anchors on unique lines so a moved block costs little', () => {
    const a = splitLines('1\n2\n3\n4\n5\n6\n');
    const b = splitLines('4\n5\n6\n1\n2\n3\n');
    const d = diffLines(a, b);
    assertValid(a, b, d.matches);
    expect(d.matches.length).toBe(3);
  });

  it('stays valid, with coarser chunks, when the budget is tiny', () => {
    const rand = mulberry32(1);
    const a = Array.from({ length: 400 }, () => `${Math.floor(rand() * 5)}\n`);
    const b = Array.from({ length: 400 }, () => `${Math.floor(rand() * 5)}\n`);
    const d = diffLines(a, b, 1000);
    assertValid(a, b, d.matches);
    expect(d.spent).toBe(true);
    expect(d.work).toBe(1001);
  });
});

describe('diffChunks', () => {
  it('groups equal and changed runs', () => {
    expect(diffChunks('a\nb\nc\n', 'a\nB\nc\n').chunks).toEqual([
      { equal: true, a: ['a\n'], b: ['a\n'] },
      { equal: false, a: ['b\n'], b: ['B\n'] },
      { equal: true, a: ['c\n'], b: ['c\n'] },
    ]);
  });
});

describe('merge3 — the cases git merge-file documents', () => {
  it('takes a change made on one side only', () => {
    expect(merge3('a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nc\n', LOCAL)).toEqual({
      clean: true,
      body: 'a\nB\nc\n',
      spent: false,
    });
    expect(merge3('a\nb\nc\n', 'a\nb\nc\n', 'a\nb\nC\n', LOCAL)).toEqual({
      clean: true,
      body: 'a\nb\nC\n',
      spent: false,
    });
  });

  it('takes an identical change once', () => {
    expect(merge3('a\nb\nc\n', 'a\nX\nc\n', 'a\nX\nc\n', LOCAL)).toEqual({
      clean: true,
      body: 'a\nX\nc\n',
      spent: false,
    });
  });

  it('merges changes to separate lines from both sides', () => {
    expect(
      merge3('a\nb\nc\nd\ne\n', 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n', LOCAL)
    ).toEqual({
      clean: true,
      body: 'A\nb\nc\nd\nE\n',
      spent: false,
    });
  });

  it('marks overlapping changes with local labels and names the head line', () => {
    const r = merge3('a\nb\nc\n', 'a\nH\nc\n', 'a\nM\nc\n', LOCAL);
    expect(r.clean).toBe(false);
    if (r.clean) return;
    expect(r.hunks).toEqual([
      { line: 2, base: ['b\n'], head: ['H\n'], mine: ['M\n'] },
    ]);
    expect(r.marked).toBe(
      'a\n<<<<<<< head (rev 13, human:wyat)\nH\n||||||| base (rev 12)\nb\n=======\nM\n>>>>>>> yours\nc\n'
    );
  });

  it('conflicts on insertions at one position unless they are identical', () => {
    expect(merge3('a\nb\n', 'a\nX\nb\n', 'a\nY\nb\n', LOCAL).clean).toBe(false);
    expect(merge3('a\nb\n', 'a\nX\nb\n', 'a\nX\nb\n', LOCAL)).toEqual({
      clean: true,
      body: 'a\nX\nb\n',
      spent: false,
    });
  });

  it('conflicts on delete against modify', () => {
    expect(merge3('a\nb\nc\n', 'a\nc\n', 'a\nB\nc\n', LOCAL).clean).toBe(false);
  });

  it('merges from an empty base', () => {
    expect(merge3('', 'x\n', '', LOCAL)).toEqual({
      clean: true,
      body: 'x\n',
      spent: false,
    });
    expect(merge3('', 'x\n', 'y\n', LOCAL).clean).toBe(false);
  });

  it('keeps a missing final newline, and adds one before a marker', () => {
    expect(merge3('x\na\ny\nb', 'x\nA\ny\nb', 'x\na\ny\nB', LOCAL)).toEqual({
      clean: true,
      body: 'x\nA\ny\nB',
      spent: false,
    });
    const r = merge3('x\nb', 'x\nH', 'x\nM', LOCAL);
    expect(r.clean ? '' : r.marked).toBe(
      'x\n<<<<<<< head (rev 13, human:wyat)\nH\n||||||| base (rev 12)\nb\n=======\nM\n>>>>>>> yours\n'
    );
  });

  it('labels stored bodies by revision id only', () => {
    const r = merge3('a\n', 'b\n', 'c\n', {
      head: 'rev-01AAA',
      base: 'rev-01BBB',
      mine: 'rev-01CCC',
    });
    expect(r.clean ? '' : r.marked).toBe(
      '<<<<<<< rev-01AAA\nb\n||||||| rev-01BBB\na\n=======\nc\n>>>>>>> rev-01CCC\n'
    );
    expect(MERGE_ALGO).toBe('diff3-patience/1');
  });
});

describe('merge3 — properties over seeded bodies', () => {
  const VOCAB = [
    'alpha\n',
    'beta\n',
    'gamma\n',
    '\n',
    '## H\n',
    'delta\n',
    'eps\n',
  ];
  function body(rand: () => number, n: number): string {
    return Array.from(
      { length: n },
      () => VOCAB[Math.floor(rand() * VOCAB.length)]
    ).join('');
  }
  function edit(rand: () => number, text: string): string {
    const lines = splitLines(text);
    for (let k = 0; k < 5; k++) {
      const at = Math.floor(rand() * (lines.length + 1));
      const kind = Math.floor(rand() * 3);
      if (kind === 0) lines.splice(at, 0, `new${Math.floor(rand() * 1000)}\n`);
      else if (kind === 1 && lines.length > 0)
        lines.splice(Math.min(at, lines.length - 1), 1);
      else if (lines.length > 0)
        lines[Math.min(at, lines.length - 1)] =
          `chg${Math.floor(rand() * 1000)}\n`;
    }
    return lines.join('');
  }

  // 50 forces the coarse path on every iteration: bodies here run to 220 lines.
  for (const budget of [2_000_000, 50]) {
    it(`holds merge(b,x,b)=x, merge(b,b,y)=y, merge(b,x,x)=x and determinism at budget ${budget}`, () => {
      const rand = mulberry32(42);
      for (let iter = 0; iter < 200; iter++) {
        const b = body(rand, 20 + Math.floor(rand() * 200));
        const x = edit(rand, b);
        const y = edit(rand, b);
        expect(merge3(b, x, b, LOCAL, budget)).toMatchObject({
          clean: true,
          body: x,
        });
        expect(merge3(b, b, y, LOCAL, budget)).toMatchObject({
          clean: true,
          body: y,
        });
        expect(merge3(b, x, x, LOCAL, budget)).toMatchObject({
          clean: true,
          body: x,
        });
        expect(merge3(b, x, y, LOCAL, budget)).toEqual(
          merge3(b, x, y, LOCAL, budget)
        );
      }
    });
  }
});
