import { describe, expect, test } from 'bun:test';

import { splitKeycaps } from './keycaps';

describe('splitKeycaps', () => {
  test('one token is one keycap', () => {
    expect(splitKeycaps('⌘1')).toEqual(['⌘1']);
    expect(splitKeycaps('C')).toEqual(['C']);
  });

  test('whitespace separates chord keys into their own keycaps', () => {
    expect(splitKeycaps('G S')).toEqual(['G', 'S']);
    expect(splitKeycaps('  ⌥   U ')).toEqual(['⌥', 'U']);
  });

  test('an empty string yields no keycaps', () => {
    expect(splitKeycaps('')).toEqual([]);
  });
});
