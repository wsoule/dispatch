import { describe, expect, test } from 'bun:test';

import { flightStructureKey, flightWaves } from './flightStructure';

describe('flightStructureKey', () => {
  test('the key sees the structure, and the waves read it back', () => {
    const base = [
      { id: 'a', created: '1', blockedBy: [], band: null },
      { id: 'b', created: '2', blockedBy: ['a'], band: null },
    ];
    const key = flightStructureKey(base, null);
    expect(key).toBe(flightStructureKey([...base], null));
    expect(key).not.toBe(
      flightStructureKey([base[0], { ...base[1], blockedBy: [] }], null)
    );
    expect(key).not.toBe(flightStructureKey(base, []));
    expect([...flightWaves(key)]).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });
});
