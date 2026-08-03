import { render } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { StateMark } from './state-mark';

const STATES = [
  'working',
  'waiting',
  'failed',
  'review',
  'landing',
  'ready',
  'blocked',
] as const;

// Without hue, form is the only thing telling states apart, so every state must
// produce a visually distinct mark rather than the same circle in a new colour.
test('every state renders a distinct mark', () => {
  const seen = new Set<string>();
  for (const state of STATES) {
    const { container } = render(<StateMark state={state} />);
    const mark = container.firstElementChild as HTMLElement;
    seen.add(mark.getAttribute('class') ?? '');
  }
  expect(seen.size).toBe(STATES.length);
});

// Pulse means "in flight" and nothing else. feedState.ts's IN_FLIGHT set is
// `working` *and* `landing`; what must not happen is a third state taking it.
test('exactly the in-flight states pulse by default', () => {
  const pulsing: string[] = [];
  for (const state of STATES) {
    const { container } = render(<StateMark state={state} />);
    if (container.innerHTML.includes('animate-pulse')) pulsing.push(state);
  }
  expect(pulsing.sort()).toEqual(['landing', 'working']);
});

// `failed` used to differ from `waiting` only by a ring in a border tone, which
// is all but invisible against the light theme's near-white ground.
test('failed differs from waiting by silhouette, not by a ring', () => {
  const { container: failed } = render(<StateMark state="failed" />);
  const { container: waiting } = render(<StateMark state="waiting" />);
  expect(failed.innerHTML).toContain('clip-path');
  expect(failed.innerHTML).not.toContain('ring-');
  expect(waiting.innerHTML).not.toContain('clip-path');
});

test('the mark is hidden from assistive tech', () => {
  const { container } = render(<StateMark state="failed" />);
  expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
});
