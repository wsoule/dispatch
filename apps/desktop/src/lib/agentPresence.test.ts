import { describe, expect, test } from 'bun:test';

import { type OrbInput, orbLabel, orbState } from './agentPresence';

const quiet: OrbInput = {
  revoked: false,
  broken: false,
  asks: 0,
  review: 0,
  turnLive: false,
  liveRuns: 0,
};

describe('orbState', () => {
  test('idle with nothing going on', () => {
    expect(orbState(quiet)).toEqual({
      tone: 'idle',
      count: null,
      spinning: false,
    });
  });

  test('off wins over everything', () => {
    expect(
      orbState({
        ...quiet,
        revoked: true,
        broken: true,
        asks: 3,
        turnLive: true,
      })
    ).toEqual({ tone: 'off', count: null, spinning: false });
  });

  test('broken wins over asks', () => {
    expect(orbState({ ...quiet, broken: true, asks: 3 }).tone).toBe('broken');
  });

  test('asks are amber with their count, even with reviews waiting', () => {
    expect(orbState({ ...quiet, asks: 5, review: 1 })).toEqual({
      tone: 'amber',
      count: 5,
      spinning: false,
    });
  });

  test('reviews alone are green, never amber', () => {
    expect(orbState({ ...quiet, review: 2 })).toEqual({
      tone: 'green',
      count: 2,
      spinning: false,
    });
  });

  test('a live turn spins in the current colour', () => {
    expect(orbState({ ...quiet, asks: 1, turnLive: true })).toEqual({
      tone: 'amber',
      count: 1,
      spinning: true,
    });
    expect(orbState({ ...quiet, turnLive: true })).toEqual({
      tone: 'motion',
      count: null,
      spinning: true,
    });
  });

  test('live runs alone are motion', () => {
    expect(orbState({ ...quiet, liveRuns: 2 }).tone).toBe('motion');
  });
});

describe('orbLabel', () => {
  test('names every non-zero group and the reviews', () => {
    expect(
      orbLabel({
        state: { tone: 'amber', count: 3, spinning: false },
        groups: { work: 2, admin: 1 },
        review: 1,
      })
    ).toBe(
      'Overseer · 3 waiting on you (work 2 · admin 1) · 1 ready for review'
    );
  });

  test('off and broken say what to do', () => {
    expect(
      orbLabel({
        state: { tone: 'off', count: null, spinning: false },
        groups: {},
        review: 0,
      })
    ).toBe('Overseer · off · approve it again in Settings › Connected agents');
    expect(
      orbLabel({
        state: { tone: 'broken', count: null, spinning: false },
        groups: {},
        review: 0,
      })
    ).toBe('Overseer · not reachable');
  });

  test('a quiet orb says so', () => {
    expect(
      orbLabel({
        state: { tone: 'idle', count: null, spinning: false },
        groups: {},
        review: 0,
      })
    ).toBe('Overseer · nothing waiting on you');
  });
});
