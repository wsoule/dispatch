import { render } from '@testing-library/react';
import { expect, test } from 'bun:test';

import {
  FEED_STATE_ORDER,
  feedStateTone,
  isInFlightState,
} from '../../lib/feedState';
import { StateMark } from './StateMark';

/** The lucide-<name> class that names a rendered glyph, skipping the shared `lucide`. */
function glyphClass(element: Element | null): string {
  return (
    (element?.getAttribute('class') ?? '')
      .split(' ')
      .find((name) => name.startsWith('lucide-')) ?? ''
  );
}

// The tone carries only the tier, so the glyph is what tells states apart: every state
// must render a distinct lucide icon, not one shape recoloured.
test('every state renders a distinct glyph', () => {
  const seen = new Set<string>();
  for (const state of FEED_STATE_ORDER) {
    const { container, unmount } = render(<StateMark state={state} />);
    seen.add(glyphClass(container.firstElementChild));
    unmount();
  }
  seen.delete('');
  expect(seen.size).toBe(FEED_STATE_ORDER.length);
});

// Only in-flight (machine-tier) states pulse, and only when asked. The pulse is data, so
// the stylesheet's motion query owns whether it animates.
test('only in-flight states pulse, and only when asked', () => {
  for (const state of FEED_STATE_ORDER) {
    const { container, unmount } = render(<StateMark state={state} pulse />);
    const pulses =
      container.firstElementChild?.getAttribute('data-pulse') === 'true';
    expect(pulses).toBe(isInFlightState(state));
    unmount();
  }
  const { container: still } = render(<StateMark state="working" />);
  expect(still.firstElementChild?.hasAttribute('data-pulse')).toBe(false);
  const { container: dot } = render(
    <StateMark state="working" variant="dot" pulse />
  );
  expect(dot.firstElementChild?.getAttribute('data-pulse')).toBe('true');
});

// Failed and waiting differ by shape, not only by colour.
test('failed and waiting are different glyphs, not different colours', () => {
  const { container: failed } = render(<StateMark state="failed" />);
  const { container: waiting } = render(<StateMark state="answer" />);
  expect(glyphClass(failed.firstElementChild)).toBe('lucide-circle-x');
  // lucide names it message-circle-question-mark now; the legacy test matched the prefix.
  expect(glyphClass(waiting.firstElementChild)).toContain(
    'lucide-message-circle-question'
  );
});

// Decorative beside a row's own words; an image with a name when it stands alone.
test('the mark is hidden from assistive tech unless it is labelled', () => {
  const { container: hidden } = render(<StateMark state="failed" />);
  const mark = hidden.firstElementChild;
  expect(mark?.getAttribute('aria-hidden')).toBe('true');
  expect(mark?.hasAttribute('role')).toBe(false);

  const { getByRole } = render(<StateMark state="failed" label="Failed" />);
  const named = getByRole('img', { name: 'Failed' });
  expect(named.hasAttribute('aria-hidden')).toBe(false);
});

// The hue comes from the tier through the data-tone hook, for the glyph and the dot alike.
test('every state carries its tier tone', () => {
  for (const state of FEED_STATE_ORDER) {
    for (const variant of ['icon', 'dot'] as const) {
      const { container, unmount } = render(
        <StateMark state={state} variant={variant} />
      );
      expect(container.firstElementChild?.getAttribute('data-tone')).toBe(
        feedStateTone(state)
      );
      unmount();
    }
  }
});

// A closed-out run is nobody's move: a filled neutral mark, never green and never pulsing.
// The disc is one filled circle with no outer stroke (an edge in the surface colour drew a
// light ring on tinted rows), and what is cut out of it says how the run closed: a check
// for work that landed, a bar for work closed without landing.
test('done and closed are a neutral disc with no tone, a check or a bar cut out', () => {
  const cuts: string[] = [];
  for (const state of ['done', 'closed'] as const) {
    const { container, unmount } = render(<StateMark state={state} pulse />);
    const mark = container.firstElementChild;
    expect(mark?.getAttribute('data-state')).toBe(state);
    expect(mark?.hasAttribute('data-tone')).toBe(false);
    expect(mark?.hasAttribute('data-pulse')).toBe(false);
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    expect(mark?.getAttribute('width')).toBe('14');
    const circles = mark?.querySelectorAll('circle') ?? [];
    expect(circles).toHaveLength(1);
    expect(circles[0]?.hasAttribute('stroke')).toBe(false);
    cuts.push(mark?.querySelector('path')?.getAttribute('d') ?? '');
    unmount();

    const { container: dot, unmount: unmountDot } = render(
      <StateMark state={state} variant="dot" />
    );
    expect(dot.firstElementChild?.hasAttribute('data-tone')).toBe(false);
    unmountDot();
  }
  expect(cuts[0]).not.toBe('');
  expect(cuts[0]).not.toBe(cuts[1]);
});

// md is the 14px glyph, sm the 12px one, both at the app's 1.8 stroke.
test('the glyph is 14px, 12px small, at a 1.8 stroke', () => {
  const { container: md } = render(<StateMark state="review" />);
  expect(md.firstElementChild?.getAttribute('width')).toBe('14');
  expect(md.firstElementChild?.getAttribute('stroke-width')).toBe('1.8');
  const { container: sm } = render(<StateMark state="review" size="sm" />);
  expect(sm.firstElementChild?.getAttribute('width')).toBe('12');
});
