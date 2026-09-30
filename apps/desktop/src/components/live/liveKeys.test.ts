import { describe, expect, test } from 'bun:test';

import { flightNavIndex } from '../flightplan/flightKeys';
import type { FlightBox } from '../flightplan/flightLayout';
import {
  type LiveCursor,
  type LiveNavBand,
  moveLiveCursor,
  resolveLiveKey,
  settleLiveCursor,
} from './liveKeys';

// One band from its columns, top to bottom, as the layout would place them.
function band(key: string, columns: string[][]): LiveNavBand {
  const boxes = new Map<string, FlightBox>();
  columns.forEach((ids, column) =>
    ids.forEach((id, row) =>
      boxes.set(id, { id, x: column * 288, y: row * 78, wave: column, column })
    )
  );
  const nav = flightNavIndex(boxes);
  return { key, order: nav.columns.flat(), nav };
}

// A: two waves (a1 a2 | a3); B: nothing drawn; C: one wave (c1 c2).
const BANDS = [
  band('A', [['a1', 'a2'], ['a3']]),
  band('B', []),
  band('C', [['c1', 'c2']]),
];

const at = (band: string, id: string): LiveCursor => ({ band, id });

function walk(
  start: LiveCursor | null,
  moves: Parameters<typeof moveLiveCursor>[2][]
) {
  const seen: (string | null)[] = [];
  let cursor = start;
  for (const move of moves) {
    cursor = moveLiveCursor(BANDS, cursor, move);
    seen.push(cursor === null ? null : `${cursor.band}:${cursor.id}`);
  }
  return seen;
}

describe('moveLiveCursor', () => {
  test('j walks every band’s nodes in reading order, skipping an empty band', () => {
    expect(
      walk(null, ['next', 'next', 'next', 'next', 'next', 'next'])
    ).toEqual([
      // No cursor yet: the first node.
      'A:a1',
      'A:a2',
      'A:a3',
      'C:c1',
      'C:c2',
      // The last node stays put.
      'C:c2',
    ]);
  });

  test('k walks back, into the previous band’s last node', () => {
    expect(walk(at('C', 'c1'), ['prev', 'prev', 'prev', 'prev'])).toEqual([
      'A:a3',
      'A:a2',
      'A:a1',
      'A:a1',
    ]);
  });

  test('J and K land on a band’s first node', () => {
    expect(walk(at('A', 'a2'), ['next-band', 'next-band'])).toEqual([
      'C:c1',
      'C:c1',
    ]);
    expect(walk(at('C', 'c2'), ['prev-band', 'prev-band'])).toEqual([
      'A:a1',
      'A:a1',
    ]);
  });

  test('h and l cross columns inside the band only', () => {
    expect(walk(at('A', 'a2'), ['right', 'right', 'left'])).toEqual([
      'A:a3',
      'A:a3',
      'A:a1',
    ]);
  });

  test('nothing drawn anywhere has no cursor', () => {
    expect(moveLiveCursor([band('B', [])], null, 'next')).toBeNull();
  });
});

describe('settleLiveCursor', () => {
  test('keeps a cursor that still stands on its node', () => {
    expect(settleLiveCursor(BANDS, at('A', 'a3'))).toEqual(at('A', 'a3'));
  });

  test('follows a node into the band that holds it now', () => {
    expect(settleLiveCursor(BANDS, at('Z', 'c2'))).toEqual(at('C', 'c2'));
  });

  test('a node that left hands the cursor to its band’s first, else the first anywhere', () => {
    expect(settleLiveCursor(BANDS, at('C', 'gone'))).toEqual(at('C', 'c1'));
    expect(settleLiveCursor(BANDS, at('Z', 'gone'))).toEqual(at('A', 'a1'));
    expect(settleLiveCursor(BANDS, null)).toEqual(at('A', 'a1'));
  });
});

describe('resolveLiveKey', () => {
  const key = (
    k: string,
    extra: Partial<Parameters<typeof resolveLiveKey>[0]> = {}
  ) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    at: 1_000,
    ...extra,
  });

  test('maps the view’s keys', () => {
    const commands = [
      'j',
      'k',
      'J',
      'K',
      'h',
      'l',
      'Enter',
      'o',
      'd',
      ' ',
      'Escape',
    ].map((k) => resolveLiveKey(key(k), null).command);
    expect(commands).toEqual([
      'next',
      'prev',
      'next-band',
      'prev-band',
      'left',
      'right',
      'open',
      'open-full',
      'dispatch',
      'peek',
      'close',
    ]);
  });

  test('a modified key is someone else’s shortcut', () => {
    expect(
      resolveLiveKey(key('d', { metaKey: true }), null).command
    ).toBeNull();
    expect(resolveLiveKey(key('j', { altKey: true }), null).command).toBeNull();
  });

  test('the key after g belongs to the shell’s chord, never the view', () => {
    const armed = resolveLiveKey(key('g'), null);
    expect(armed).toEqual({ command: null, gArmedAt: 1_000 });
    // `g h` goes Home; it must not also move the cursor left.
    expect(resolveLiveKey(key('h', { at: 1_300 }), armed.gArmedAt)).toEqual({
      command: null,
      gArmedAt: null,
    });
    // Past the chord window the key is the view's again.
    expect(
      resolveLiveKey(key('h', { at: 2_000 }), armed.gArmedAt).command
    ).toBe('left');
  });
});
