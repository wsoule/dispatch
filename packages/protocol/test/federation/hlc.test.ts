import { describe, expect, it } from 'bun:test';

import {
  compareHlc,
  hlcWallMs,
  MAX_HLC_COUNTER,
  parseOpHlc,
} from '../../src/federation/hlc.js';

const R = 'ada-0000000a';

function parsed(text: string) {
  const clock = parseOpHlc(text);
  if (clock === null) throw new Error(`unparsed: ${text}`);
  return clock;
}

describe('op clocks', () => {
  it('compares counters as numbers once they outgrow four digits', () => {
    const wide = `0000000001000.10000.${R}`;
    const narrow = `0000000001000.9999.${R}`;
    // Code-unit order puts "10000" before "9999"; clock order is the reverse.
    expect(wide < narrow).toBe(true);
    expect(compareHlc(parsed(wide), parsed(narrow))).toBe(1);
    expect(compareHlc(parsed(narrow), parsed(wide))).toBe(-1);
    expect(compareHlc(parsed(`0000000001001.0000.${R}`), parsed(wide))).toBe(1);
    expect(
      compareHlc(parsed(wide), parsed(`0000000001000.10000.bob-0000000b`))
    ).toBe(0);
  });

  it('reads the wall time, or null for text outside the grammar', () => {
    expect(hlcWallMs(`1758880000000.0003.${R}`)).toBe(1_758_880_000_000);
    for (const bad of ['', '1758880000000.03.r', '175888000000.0000.r'])
      expect(hlcWallMs(bad)).toBeNull();
  });

  it('refuses a counter above MAX_HLC_COUNTER, so every comparison is exact', () => {
    const at = (counter: string) => `0000000001001.${counter}.${R}`;
    expect(parsed(at(String(MAX_HLC_COUNTER))).counter).toBe(MAX_HLC_COUNTER);
    expect(Number.isSafeInteger(MAX_HLC_COUNTER * 2)).toBe(true);
    for (const over of [
      String(MAX_HLC_COUNTER + 1),
      `0${String(MAX_HLC_COUNTER)}`,
      '9007199254740993',
      '1000000000000000000000',
      '9'.repeat(400),
    ])
      expect(parseOpHlc(at(over))).toBeNull();
    const below = parsed(at(String(MAX_HLC_COUNTER - 1)));
    const top = parsed(at(String(MAX_HLC_COUNTER)));
    expect(compareHlc(below, top)).toBe(-1);
  });
});
