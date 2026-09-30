import { describe, expect, test } from 'bun:test';

import {
  FLING_REST,
  FLING_SETTLE_MS,
  sampleFling,
  trackFling,
} from './boardFling';

describe('sampleFling', () => {
  test('one fast jump is not a fling; a second fast sample in a row is', () => {
    const first = sampleFling(FLING_REST, 0, 0);
    expect(first.fast).toBe(false);
    const jump = sampleFling(first.sample, 2000, 16);
    expect(jump.fast).toBe(false);
    expect(sampleFling(jump.sample, 4000, 32).fast).toBe(true);
  });

  test('an ordinary scroll never flings', () => {
    let sample = FLING_REST;
    for (let i = 1; i <= 20; i++) {
      const next = sampleFling(sample, i * 40, i * 16);
      expect(next.fast).toBe(false);
      sample = next.sample;
    }
  });

  test('a slow sample breaks the streak', () => {
    const a = sampleFling(sampleFling(FLING_REST, 0, 0).sample, 800, 16);
    const slow = sampleFling(a.sample, 820, 32);
    expect(slow.sample.streak).toBe(0);
    expect(sampleFling(slow.sample, 1600, 48).fast).toBe(false);
  });
});

describe('trackFling', () => {
  test('settles once scrolling stops being fast, telling each waiting card', async () => {
    const element = document.createElement('div');
    const { tracker, dispose } = trackFling(element);
    let settled = 0;
    const scrollTo = (top: number) => {
      element.scrollTop = top;
      element.dispatchEvent(new Event('scroll'));
    };

    scrollTo(0);
    await new Promise((r) => setTimeout(r, 5));
    scrollTo(3000);
    await new Promise((r) => setTimeout(r, 5));
    scrollTo(6000);
    expect(tracker.isFlinging()).toBe(true);
    tracker.onSettle(() => settled++);

    await new Promise((r) => setTimeout(r, FLING_SETTLE_MS + 60));
    expect(tracker.isFlinging()).toBe(false);
    expect(settled).toBe(1);
    dispose();
  });
});
