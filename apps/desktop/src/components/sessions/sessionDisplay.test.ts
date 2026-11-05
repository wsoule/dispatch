import { describe, expect, test } from 'bun:test';

import {
  cacheHitRateDisplay,
  DEFAULT_SPEND_WINDOW,
  parseTags,
  sessionStatusTone,
  SPEND_WINDOWS,
  spendWindowLabel,
} from './sessionDisplay.ts';

describe('cacheHitRateDisplay', () => {
  test('is the share of input tokens served from cache, rounded to a percent', () => {
    // 8000 cache-read out of (1000 + 8000 + 1000) = 10000 total input = 80%.
    expect(
      cacheHitRateDisplay({
        prompt_tokens: 1000,
        cache_read_tokens: 8000,
        cache_creation_tokens: 1000,
      })
    ).toBe('80%');
  });

  test('returns a dash when there are no input tokens at all', () => {
    expect(
      cacheHitRateDisplay({
        prompt_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      })
    ).toBe('—');
  });

  test('is 0% when nothing was read from cache', () => {
    expect(
      cacheHitRateDisplay({
        prompt_tokens: 500,
        cache_read_tokens: 0,
        cache_creation_tokens: 500,
      })
    ).toBe('0%');
  });
});

describe('parseTags', () => {
  test('parses a JSON array of tags', () => {
    expect(parseTags('["bugfix","refactor"]')).toEqual(['bugfix', 'refactor']);
  });

  test('treats an unparseable string as a single tag', () => {
    expect(parseTags('not json')).toEqual(['not json']);
  });

  test('returns an empty array for null', () => {
    expect(parseTags(null)).toEqual([]);
  });
});

describe('spend windows', () => {
  test('the default window is one of the offered tabs', () => {
    expect(SPEND_WINDOWS).toContain(DEFAULT_SPEND_WINDOW);
  });

  test('a window labels itself in days', () => {
    expect(spendWindowLabel(30)).toBe('30 days');
  });
});

describe('sessionStatusTone', () => {
  // A live session is blue (info) per the status hue table; an ended one is grey (muted).
  test('an active session is info, an ended one is muted', () => {
    expect(sessionStatusTone('active')).toBe('info');
    expect(sessionStatusTone('ended')).toBe('muted');
  });
});
