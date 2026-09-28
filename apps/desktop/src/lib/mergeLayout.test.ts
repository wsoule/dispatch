import { describe, expect, it } from 'bun:test';

import { labelFor, parseMarked, resolveMarked } from './mergeLayout';

const LOCAL =
  'a\n<<<<<<< head (rev 13, human:wyat)\nH\n||||||| base (rev 12)\nB\n=======\nM\n>>>>>>> yours\nz\n';
const IDS =
  '<<<<<<< rev-01A\nH\n||||||| rev-01O\nB\n=======\nM\n>>>>>>> rev-01B\n';

describe('mergeLayout', () => {
  it('parses both marker styles into text and conflict parts', () => {
    expect(parseMarked(LOCAL)).toEqual([
      { kind: 'text', lines: ['a\n'] },
      {
        kind: 'conflict',
        head: ['H\n'],
        base: ['B\n'],
        mine: ['M\n'],
        headLabel: 'head (rev 13, human:wyat)',
        mineLabel: 'yours',
      },
      { kind: 'text', lines: ['z\n'] },
    ]);
    expect(parseMarked(IDS)[0]).toMatchObject({
      kind: 'conflict',
      headLabel: 'rev-01A',
      mineLabel: 'rev-01B',
    });
  });

  it('resolves each hunk by taking a side or an edit, adding no markers', () => {
    const parts = parseMarked(LOCAL);
    expect(resolveMarked(parts, [{ take: 'head' }])).toBe('a\nH\nz\n');
    expect(resolveMarked(parts, [{ take: 'mine' }])).toBe('a\nM\nz\n');
    expect(resolveMarked(parts, [{ take: 'edit', text: 'both H and M' }])).toBe(
      'a\nboth H and M\nz\n'
    );
  });

  it('shows a revision id as "rev N by X"', () => {
    expect(
      labelFor('rev-01A', [{ id: 'rev-01A', n: 7, author: 'run:r-1' }])
    ).toBe('rev 7 by run:r-1');
    expect(labelFor('yours', [])).toBe('yours');
  });

  it('leaves a body without markers as one text part', () => {
    expect(parseMarked('plain\n')).toEqual([
      { kind: 'text', lines: ['plain\n'] },
    ]);
  });

  it('reads a block with no base section, as a whole-body 409 marks it', () => {
    const whole =
      '<<<<<<< head (rev 2, run:r-1)\nH\n=======\nM\n>>>>>>> yours\n';
    expect(parseMarked(whole)).toEqual([
      {
        kind: 'conflict',
        head: ['H\n'],
        base: [],
        mine: ['M\n'],
        headLabel: 'head (rev 2, run:r-1)',
        mineLabel: 'yours',
      },
    ]);
  });

  it('keeps a marked block inside a side whole, as when a 409 wraps a marked head', () => {
    const wrapped = `<<<<<<< head (rev 14, run:r-1)\n${LOCAL}=======\nmine\n>>>>>>> yours\n`;
    const parts = parseMarked(wrapped);
    expect(parts).toEqual([
      {
        kind: 'conflict',
        head: LOCAL.split(/(?<=\n)/),
        base: [],
        mine: ['mine\n'],
        headLabel: 'head (rev 14, run:r-1)',
        mineLabel: 'yours',
      },
    ]);
    expect(resolveMarked(parts, [{ take: 'mine' }])).toBe('mine\n');
    expect(resolveMarked(parts, [{ take: 'head' }])).toBe(LOCAL);
  });

  it('keeps a setext underline on the head side of a block with a base', () => {
    const setext =
      '<<<<<<< rev-01A\nTitle\n=======\nH\n||||||| rev-01O\nB\n=======\nM\n>>>>>>> rev-01B\n';
    expect(parseMarked(setext)).toEqual([
      {
        kind: 'conflict',
        head: ['Title\n', '=======\n', 'H\n'],
        base: ['B\n'],
        mine: ['M\n'],
        headLabel: 'rev-01A',
        mineLabel: 'rev-01B',
      },
    ]);
  });

  it('reads a base marker after the separator as your text', () => {
    const late =
      '<<<<<<< head (rev 2, run:r-1)\nH\n=======\nM\n||||||| x\n>>>>>>> yours\n';
    expect(parseMarked(late)).toEqual([
      {
        kind: 'conflict',
        head: ['H\n'],
        base: [],
        mine: ['M\n', '||||||| x\n'],
        headLabel: 'head (rev 2, run:r-1)',
        mineLabel: 'yours',
      },
    ]);
  });

  it('keeps a block whose closing marker was deleted as text, markers and all', () => {
    const open = 'a\n<<<<<<< head (rev 3, run:r-1)\nH\n=======\nM\n';
    const parts = parseMarked(open);
    expect(parts.every((p) => p.kind === 'text')).toBe(true);
    expect(resolveMarked(parts, [])).toBe(open);
  });
});
