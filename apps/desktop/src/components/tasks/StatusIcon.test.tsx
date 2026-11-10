import { pieDashOffset } from '@dispatch/ui';
import { render } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { StatusIcon } from './StatusIcon';

// The inner pie is the circle with the 4-wide stroke; the outer ring is the 1.5 one.
function circles(status: string) {
  const { container } = render(<StatusIcon status={status} />);
  const svg = container.querySelector('svg');
  if (svg === null) throw new Error('no svg');
  const all = Array.from(svg.querySelectorAll('circle'));
  return {
    svg,
    ring: all.find((c) => c.getAttribute('stroke-width') === '1.5'),
    pie: all.find((c) => c.getAttribute('stroke-width') === '4'),
    disk: all.find((c) => c.getAttribute('stroke-width') === '6'),
    cutout: svg.querySelector('path'),
  };
}

const css = readFileSync(
  join(import.meta.dir, 'StatusIcon.module.css'),
  'utf8'
);

describe('StatusIcon', () => {
  test('renders at 14px in Linear’s 14-unit viewBox', () => {
    const { svg } = circles('ready');
    expect(svg.getAttribute('viewBox')).toBe('0 0 14 14');
    expect(svg.getAttribute('width')).toBe('14');
    expect(svg.getAttribute('height')).toBe('14');
    expect(svg.getAttribute('fill')).toBe('none');
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Status: ready');
  });

  test('a caller sizes it with `size` or its own class', () => {
    const { container } = render(
      <>
        <StatusIcon status="ready" size={16} />
        <StatusIcon status="ready" className="caller-size" />
      </>
    );
    const [sized, classed] = Array.from(container.querySelectorAll('svg'));
    expect(sized?.getAttribute('width')).toBe('16');
    expect(sized?.getAttribute('height')).toBe('16');
    expect(classed?.classList.contains('caller-size')).toBe(true);
    // The module never sets a size, so a caller's class always wins.
    expect(css).not.toMatch(/\b(width|height)\s*:/);
  });

  test('draft is the dashed backlog ring with an empty pie', () => {
    const { svg, ring, pie } = circles('draft');
    expect(ring?.getAttribute('stroke-dasharray')).toBe('1.4 1.74');
    expect(ring?.getAttribute('stroke-dashoffset')).toBe('0.65');
    expect(pie?.getAttribute('stroke-dashoffset')).toBe(
      String(pieDashOffset(0))
    );
    expect(svg.getAttribute('data-status-shape')).toBe('backlog');
    expect(svg.getAttribute('data-tone')).toBe('muted');
  });

  test('ready is the solid todo ring with an empty pie', () => {
    const { svg, ring, pie } = circles('ready');
    expect(ring?.getAttribute('r')).toBe('6');
    expect(ring?.getAttribute('stroke-dasharray')).toBe('3.14 0');
    expect(ring?.getAttribute('stroke-dashoffset')).toBe('-0.7');
    expect(pie?.getAttribute('r')).toBe('2');
    expect(pie?.getAttribute('stroke-dasharray')).toBe(
      '12.189379495928398 24.378758991856795'
    );
    expect(pie?.getAttribute('stroke-dashoffset')).toBe('12.189379495928398');
    expect(pie?.getAttribute('transform')).toBe('rotate(-90 7 7)');
    expect(svg.getAttribute('data-status-shape')).toBe('pie');
    expect(svg.getAttribute('data-tone')).toBe('muted');
  });

  test.each([
    ['working', 0.5, 'info'],
    ['review', 0.75, 'success'],
    ['landing', 0.9, 'info'],
  ])('%s exposes %d of the pie', (status, fraction, tone) => {
    const { svg, pie } = circles(status);
    expect(Number(pie?.getAttribute('stroke-dashoffset'))).toBeCloseTo(
      pieDashOffset(fraction),
      6
    );
    expect(svg.getAttribute('data-tone')).toBe(tone);
  });

  test('the 50% offset is Linear’s 6.0947', () => {
    expect(pieDashOffset(0.5)).toBeCloseTo(6.0947, 3);
    expect(pieDashOffset(0.75)).toBeCloseTo(3.0473, 3);
    expect(pieDashOffset(1)).toBe(0);
  });

  test('landed is the neutral filled disk with a check cut out in the surface colour', () => {
    const { svg, pie, disk, cutout } = circles('landed');
    expect(pie).toBeUndefined();
    expect(disk?.getAttribute('r')).toBe('3');
    expect(disk?.getAttribute('stroke-dasharray')).toBe(
      '18.84955592153876 37.69911184307752'
    );
    expect(disk?.getAttribute('stroke-dashoffset')).toBe('0');
    expect(cutout?.getAttribute('fill')).toBe('var(--surface)');
    expect(cutout?.getAttribute('d')?.startsWith('M10.951 4.24896')).toBe(true);
    expect(svg.getAttribute('data-status-shape')).toBe('done');
    // Done has no tone: the module's neutral --text-2 fill, never green.
    expect(svg.hasAttribute('data-tone')).toBe(false);
    expect(css).toMatch(/\.icon\s*\{[^}]*color:\s*var\(--text-2\)/);
    expect(css).toMatch(/\.icon\[data-tone\]\s*\{[^}]*color:\s*var\(--tone\)/);
  });

  test('dropped is the cancelled disk with an × cut out', () => {
    const { svg, disk, cutout } = circles('dropped');
    expect(disk).toBeDefined();
    expect(svg.getAttribute('data-status-shape')).toBe('cancelled');
    expect(cutout?.getAttribute('d')?.startsWith('M10.951')).toBe(false);
    expect(svg.getAttribute('data-tone')).toBe('muted');
  });

  test('blocked is amber but keeps the shape', () => {
    const { container } = render(<StatusIcon status="working" blocked />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('data-tone')).toBe('warning');
    expect(svg?.getAttribute('data-status-shape')).toBe('pie');
  });

  test('a tone wins over blocked and the status tone, keeping the shape', () => {
    // VerificationSection draws a failed check as the cancelled disk in danger red.
    const { container } = render(
      <StatusIcon status="dropped" blocked tone="danger" />
    );
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('data-tone')).toBe('danger');
    expect(svg?.getAttribute('data-status-shape')).toBe('cancelled');
  });

  test('a custom status falls back to the empty todo ring', () => {
    const { svg, pie } = circles('triage');
    expect(pie?.getAttribute('stroke-dashoffset')).toBe('12.189379495928398');
    expect(svg.getAttribute('data-tone')).toBe('muted');
  });

  test('forced colours keep the glyph and its cut-out', () => {
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toMatch(/\.cutout\s*\{[^}]*fill:\s*Canvas/);
  });
});
