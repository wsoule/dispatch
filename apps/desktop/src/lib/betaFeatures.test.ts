import { afterEach, describe, expect, test } from 'bun:test';

import {
  BETA_FEATURES,
  BETA_STORAGE_KEY,
  isBetaOn,
  parseBetaFlags,
  setBetaFlag,
  subscribeBeta,
  twoViewsAllowed,
} from './betaFeatures';

afterEach(() => {
  window.localStorage.clear();
  setBetaFlag('two-views', false);
  window.localStorage.clear();
});

describe('parseBetaFlags', () => {
  test('nothing stored means every beta is off', () => {
    expect(parseBetaFlags(null)).toEqual(new Set());
  });

  test('known flags survive, unknown and junk entries are dropped', () => {
    expect(parseBetaFlags('["two-views","retired-flag",7]')).toEqual(
      new Set(['two-views'])
    );
  });

  test.each(['{', 'null', '"two-views"', '{"two-views":true}'])(
    'junk (%p) reads as all off',
    (stored) => {
      expect(parseBetaFlags(stored)).toEqual(new Set());
    }
  );
});

describe('the flag store', () => {
  test('every registered beta has a label and a description', () => {
    for (const feature of BETA_FEATURES) {
      expect(feature.label.length).toBeGreaterThan(0);
      expect(feature.description.length).toBeGreaterThan(0);
    }
  });

  test('Two views is off until turned on, and stays on once stored', () => {
    expect(isBetaOn('two-views')).toBe(false);
    setBetaFlag('two-views', true);
    expect(isBetaOn('two-views')).toBe(true);
    expect(window.localStorage.getItem(BETA_STORAGE_KEY)).toBe('["two-views"]');
    setBetaFlag('two-views', false);
    expect(isBetaOn('two-views')).toBe(false);
    expect(window.localStorage.getItem(BETA_STORAGE_KEY)).toBe('[]');
  });

  test('a change notifies subscribers, and unsubscribing stops it', () => {
    let calls = 0;
    const unsubscribe = subscribeBeta(() => calls++);
    setBetaFlag('two-views', true);
    expect(calls).toBe(1);
    unsubscribe();
    setBetaFlag('two-views', false);
    expect(calls).toBe(1);
  });

  test('a throwing storage keeps the flag for the session without throwing', () => {
    const original = window.localStorage;
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    Object.defineProperty(window, 'localStorage', {
      value: throwing,
      configurable: true,
    });
    try {
      expect(() => setBetaFlag('two-views', true)).not.toThrow();
      expect(isBetaOn('two-views')).toBe(true);
    } finally {
      Object.defineProperty(window, 'localStorage', {
        value: original,
        configurable: true,
      });
    }
  });
});

describe('twoViewsAllowed', () => {
  test('the desktop app can always use it', () => {
    expect(twoViewsAllowed({ teamLocal: false, tier: 'decide' })).toBe(true);
  });

  test('a team-local page offers it to its operator only', () => {
    expect(twoViewsAllowed({ teamLocal: true, tier: 'operator' })).toBe(true);
    expect(twoViewsAllowed({ teamLocal: true, tier: 'decide' })).toBe(false);
    expect(twoViewsAllowed({ teamLocal: true, tier: null })).toBe(false);
  });
});
