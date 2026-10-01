import { describe, expect, it } from 'bun:test';

import {
  compareHlc,
  hlcWallMs,
  MAX_HLC_COUNTER,
  OpClock,
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

describe('OpClock', () => {
  const WALL = 1_758_880_000_000;
  const B = 'bob-0000000b';
  const at = (ms: number, counter: number | string, replica = R) =>
    `${String(ms)}.${String(counter).padStart(4, '0')}.${replica}`;

  it('ticks past its last reading, taking the wall time when it moves ahead', () => {
    let wall = WALL;
    const clock = new OpClock(R, null, () => wall);
    expect(clock.tick()).toBe(at(WALL, 0));
    expect(clock.tick()).toBe(at(WALL, 1));
    wall += 5;
    expect(clock.tick()).toBe(at(WALL + 5, 0));
    expect(clock.last).toBe(at(WALL + 5, 0));
    expect(new OpClock(R, clock.last, () => WALL).tick()).toBe(at(WALL + 5, 1));
  });

  it('rolls into the next ms instead of passing MAX_HLC_COUNTER', () => {
    const clock = new OpClock(R, at(WALL, MAX_HLC_COUNTER - 1), () => WALL);
    expect(clock.tick()).toBe(at(WALL, MAX_HLC_COUNTER));
    expect(clock.tick()).toBe(at(WALL + 1, 0));
    expect(clock.tick()).toBe(at(WALL + 1, 1));
  });

  it("stays in the grammar after adopting a peer's reading at the bound", () => {
    const clock = new OpClock(R, null, () => WALL);
    const remote = at(WALL + 240_000, MAX_HLC_COUNTER, B);
    clock.observe(remote);
    const next = clock.tick();
    expect(next).toBe(at(WALL + 240_001, 0));
    expect(compareHlc(parsed(next), parsed(remote))).toBe(1);
  });

  it('clamps a wider counter it observes or restarts from, and still ticks past it', () => {
    const wide = at(WALL, '99999999999', B);
    const observer = new OpClock(R, null, () => WALL);
    observer.observe(wide);
    expect(observer.last).toBe(at(WALL, MAX_HLC_COUNTER));
    expect(observer.tick()).toBe(at(WALL + 1, 0));
    const restarted = new OpClock(R, at(WALL, '9'.repeat(400)), () => WALL);
    expect(restarted.tick()).toBe(at(WALL + 1, 0));
  });

  it('never moves back for an earlier or unreadable reading', () => {
    const clock = new OpClock(R, at(WALL, 7), () => WALL - 60_000);
    for (const behind of [at(WALL, 6, B), at(WALL - 1, 99, B), 'x', ''])
      clock.observe(behind);
    expect(clock.tick()).toBe(at(WALL, 8));
  });
});
