import { render } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { StateMark } from './state-mark';

// Without hue, form is the only thing telling states apart, so every state must
// produce a visually distinct mark rather than the same circle in a new colour.
test('every state renders a distinct mark', () => {
  const states = [
    'working',
    'waiting',
    'failed',
    'review',
    'landing',
    'ready',
    'blocked',
  ] as const;
  const seen = new Set<string>();
  for (const state of states) {
    const { container } = render(<StateMark state={state} />);
    const mark = container.firstElementChild as HTMLElement;
    seen.add(mark.getAttribute('class') ?? '');
  }
  expect(seen.size).toBe(states.length);
});

test('only the working state pulses by default', () => {
  const { container: working } = render(<StateMark state="working" />);
  const { container: ready } = render(<StateMark state="ready" />);
  expect(working.innerHTML).toContain('animate-pulse');
  expect(ready.innerHTML).not.toContain('animate-pulse');
});

test('the mark is hidden from assistive tech', () => {
  const { container } = render(<StateMark state="failed" />);
  expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
});
