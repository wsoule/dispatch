import { describe, expect, test } from 'bun:test';

import {
  isPinnedToBottom,
  type ScrollMetrics,
  STICK_TO_BOTTOM_THRESHOLD_PX,
} from './scroll';

// A 400px-tall viewport over 1000px of content, so the true bottom is scrollTop 600.
function metrics(scrollTop: number): ScrollMetrics {
  return { scrollTop, scrollHeight: 1000, clientHeight: 400 };
}

describe('isPinnedToBottom', () => {
  test('is pinned at the exact bottom', () => {
    expect(isPinnedToBottom(metrics(600))).toBe(true);
  });

  test('is pinned within the slack threshold', () => {
    expect(isPinnedToBottom(metrics(600 - STICK_TO_BOTTOM_THRESHOLD_PX))).toBe(
      true
    );
  });

  test('is not pinned once scrolled past the threshold', () => {
    expect(
      isPinnedToBottom(metrics(600 - STICK_TO_BOTTOM_THRESHOLD_PX - 1))
    ).toBe(false);
  });

  test('is not pinned when scrolled up to read history', () => {
    expect(isPinnedToBottom(metrics(0))).toBe(false);
  });

  test('is pinned when the content is shorter than the viewport', () => {
    expect(
      isPinnedToBottom({ scrollTop: 0, scrollHeight: 120, clientHeight: 400 })
    ).toBe(true);
  });

  test('honours an explicit threshold', () => {
    expect(isPinnedToBottom(metrics(500), 100)).toBe(true);
    expect(isPinnedToBottom(metrics(500), 99)).toBe(false);
  });
});
