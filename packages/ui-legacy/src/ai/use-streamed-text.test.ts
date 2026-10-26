import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';

import { nextSlice, revealStep, useStreamedText } from './use-streamed-text';

describe('nextSlice', () => {
  test('extends a mid-word tick forward to the next whitespace boundary', () => {
    const full = 'The quick brown fox';
    expect(nextSlice(full, '', 5)).toBe('The quick');
  });

  test('keeps extending across ticks, never splitting a word', () => {
    const full = 'The quick brown fox';
    expect(nextSlice(full, 'The quick', 5)).toBe('The quick brown');
  });

  test('reveals the remainder in one tick once the tail fits within the step', () => {
    const full = 'The quick brown fox';
    expect(nextSlice(full, 'The quick brown', 5)).toBe(full);
  });

  test('revealing an already-complete string returns full unchanged', () => {
    const full = 'The quick brown fox';
    expect(nextSlice(full, full, 5)).toBe(full);
  });

  test('a single long word with no whitespace reveals in full rather than splitting', () => {
    const full = 'Supercalifragilisticexpialidocious';
    expect(nextSlice(full, '', 3)).toBe(full);
  });

  test('charsPerTick of zero or negative still makes progress (min 1)', () => {
    const full = 'ab cd';
    expect(nextSlice(full, '', 0)).toBe('ab');
    expect(nextSlice(full, '', -3)).toBe('ab');
  });

  test('a tick landing exactly on a whitespace boundary stops before the space', () => {
    const full = 'Hi there';
    expect(nextSlice(full, '', 2)).toBe('Hi');
  });
});

describe('revealStep', () => {
  test('reveals at the reading speed when little is hidden', () => {
    // 45 chars a second over 40ms ticks is two characters a tick.
    expect(revealStep(3, 45)).toBe(2);
  });

  test('reveals a burst within six ticks, however far behind', () => {
    expect(revealStep(600, 45)).toBe(100);
    expect(revealStep(7, 45)).toBe(2);
  });
});

describe('useStreamedText', () => {
  const TICK_MS = 40;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Advances the reveal one tick at a time: each tick's re-render schedules the next.
  function tick(times = 1) {
    for (let i = 0; i < times; i += 1) {
      act(() => {
        jest.advanceTimersByTime(TICK_MS);
      });
    }
  }

  function mount(text: string, enabled = true) {
    return renderHook(
      ({ full, on }: { full: string; on: boolean }) =>
        useStreamedText(full, { enabled: on }),
      { initialProps: { full: text, on: enabled } }
    );
  }

  test('shows the text it mounts with at once instead of typing it out', () => {
    const { result } = mount('The whole answer arrived in one piece.');
    expect(result.current).toBe('The whole answer arrived in one piece.');
  });

  test('reveals what the text grows by from where it is, never from the start', () => {
    const { result, rerender } = mount('Checking');
    rerender({ full: 'Checking the merge queue now', on: true });
    // Nothing of the old text is taken back while the new tail waits for a tick.
    expect(result.current).toBe('Checking');
    tick();
    const afterOne = result.current;
    expect(afterOne.length).toBeGreaterThan('Checking'.length);
    expect('Checking the merge queue now'.startsWith(afterOne)).toBe(true);

    // Another delta mid-reveal continues the same reveal.
    rerender({
      full: 'Checking the merge queue now: two are blocked.',
      on: true,
    });
    expect(result.current).toBe(afterOne);
    tick(12);
    expect(result.current).toBe(
      'Checking the merge queue now: two are blocked.'
    );
  });

  // A stream's deltas often land faster than a tick; each one must not push the
  // next reveal step back, or the text would sit still until the stream paused.
  test('keeps revealing while deltas land faster than a tick', () => {
    const words = 'one two three four five six seven eight nine ten'.split(' ');
    const { result, rerender } = mount(words[0]);
    let text = words[0];
    for (const word of words.slice(1)) {
      text = `${text} ${word}`;
      rerender({ full: text, on: true });
      act(() => {
        jest.advanceTimersByTime(TICK_MS / 2);
      });
    }
    expect(result.current.length).toBeGreaterThan(words[0].length);
    tick(6);
    expect(result.current).toBe(text);
  });

  test('catches up with a burst within six ticks', () => {
    const { result, rerender } = mount('Start.');
    const burst = `Start.${' word'.repeat(150)}`;
    rerender({ full: burst, on: true });
    tick(5);
    expect(result.current.length).toBeLessThan(burst.length);
    tick();
    expect(result.current).toBe(burst);
  });

  test('a text that does not continue the old one shows whole', () => {
    const { result, rerender } = mount('First answer');
    rerender({ full: 'A different answer', on: true });
    expect(result.current).toBe('A different answer');
  });

  test('shows growth at once when the reveal is off', () => {
    const { result, rerender } = mount('Checking', false);
    rerender({ full: 'Checking the queue', on: false });
    expect(result.current).toBe('Checking the queue');
  });
});
