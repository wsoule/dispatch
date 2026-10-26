import { render } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import { PIE_DASH, pieDashOffset, ProgressGlyph } from './ProgressGlyph';

function pie(fraction: number) {
  const { container } = render(<ProgressGlyph fraction={fraction} />);
  const circles = Array.from(container.querySelectorAll('circle'));
  return {
    svg: container.querySelector('svg'),
    ring: circles.find((c) => c.getAttribute('stroke-width') === '1.5'),
    pie: circles.find((c) => c.getAttribute('stroke-width') === '4'),
  };
}

describe('ProgressGlyph', () => {
  test('the dasharray is the full arc followed by a gap twice as long', () => {
    const { pie: arc } = pie(0.5);
    expect(arc?.getAttribute('stroke-dasharray')).toBe(
      `${PIE_DASH} ${PIE_DASH * 2}`
    );
    expect(arc?.getAttribute('transform')).toBe('rotate(-90 7 7)');
  });

  test.each([
    [0, PIE_DASH],
    [0.5, PIE_DASH / 2],
    [1, 0],
  ])('fraction %d offsets the pie by %d', (fraction, offset) => {
    expect(pieDashOffset(fraction)).toBeCloseTo(offset, 9);
    expect(
      Number(pie(fraction).pie?.getAttribute('stroke-dashoffset'))
    ).toBeCloseTo(offset, 9);
  });

  test('the ring is the status icon’s r=6 ring inside a 14-unit viewBox', () => {
    const { svg, ring } = pie(0);
    expect(svg?.getAttribute('viewBox')).toBe('0 0 14 14');
    expect(ring?.getAttribute('r')).toBe('6');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  test('a caller can add classes without losing the 12px default', () => {
    const { container } = render(
      <ProgressGlyph fraction={0.25} className="text-foreground" />
    );
    const svg = container.querySelector('svg');
    expect(svg?.classList.contains('size-3')).toBe(true);
    expect(svg?.classList.contains('text-foreground')).toBe(true);
  });
});
