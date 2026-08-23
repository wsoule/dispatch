import { render } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { StateMark } from './state-mark';

const STATES = [
  'answer',
  'approve',
  'review',
  'ruling',
  'unblock',
  'failed',
  'working',
  'fixing',
  'checking',
  'landing',
  'ready',
  'blocked',
] as const;

// Hue carries only the tier, so the glyph is what tells states apart — every
// state must render a distinct lucide icon, not one shape recoloured.
test('every state renders a distinct glyph', () => {
  const seen = new Set<string>();
  for (const state of STATES) {
    const { container } = render(<StateMark state={state} />);
    const glyph = (container.firstElementChild?.getAttribute('class') ?? '')
      .split(' ')
      .find((c) => c.startsWith('lucide-') && c !== 'lucide');
    seen.add(glyph ?? '');
  }
  expect(seen.size).toBe(STATES.length);
});

// Pulse means "in flight" and nothing else — exactly the machine tier, and no
// state outside it may take it.
test('exactly the machine tier pulses by default', () => {
  const pulsing: string[] = [];
  for (const state of STATES) {
    const { container } = render(<StateMark state={state} />);
    if (container.innerHTML.includes('animate-pulse')) pulsing.push(state);
  }
  expect(pulsing.sort()).toEqual(['checking', 'fixing', 'landing', 'working']);
});

// Every state is its own lucide glyph — not one shape recoloured — so the marks
// stay tellable-apart without hue.
test('failed and waiting are different glyphs, not different colours', () => {
  const { container: failed } = render(<StateMark state="failed" />);
  const { container: waiting } = render(<StateMark state="answer" />);
  expect(failed.innerHTML).toContain('lucide-circle-x');
  expect(waiting.innerHTML).toContain('lucide-message-circle-question');
});

test('the mark is hidden from assistive tech', () => {
  const { container } = render(<StateMark state="failed" />);
  expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
});
