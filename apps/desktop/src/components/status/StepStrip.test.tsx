import { render } from '@testing-library/react';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Step, StepStrip } from './StepStrip';

const css = readFileSync(join(import.meta.dir, 'StepStrip.module.css'), 'utf8');

const STEPS: Step[] = [
  { name: 'Wave 1', status: 'passed' },
  { name: 'Wave 2', status: 'failed' },
  { name: 'Wave 3', status: 'active' },
  { name: 'Wave 4', status: 'pending' },
];

function segments(container: HTMLElement): HTMLLIElement[] {
  return Array.from(container.querySelectorAll('ol > li'));
}

test('draws one segment per step, in order, inside one list', () => {
  const { container } = render(<StepStrip steps={STEPS} />);
  expect(container.querySelectorAll('ol')).toHaveLength(1);
  expect(segments(container)).toHaveLength(4);
});

test('tones each segment by its status: passed success, failed danger, active info, pending muted', () => {
  const { container } = render(<StepStrip steps={STEPS} />);
  expect(
    segments(container).map((li) => [
      li.getAttribute('data-status'),
      li.getAttribute('data-tone'),
    ])
  ).toEqual([
    ['passed', 'success'],
    ['failed', 'danger'],
    ['active', 'info'],
    ['pending', 'muted'],
  ]);
});

test('names every segment for screen readers and in its hover title', () => {
  const { container } = render(<StepStrip steps={STEPS} />);
  const lis = segments(container);
  expect(lis.map((li) => li.getAttribute('title'))).toEqual([
    'Wave 1 · passed',
    'Wave 2 · failed',
    'Wave 3 · active',
    'Wave 4 · pending',
  ]);
  expect(
    lis.map((li) => li.querySelector('.srOnly')?.textContent ?? null)
  ).toEqual([
    'Wave 1: passed',
    'Wave 2: failed',
    'Wave 3: active',
    'Wave 4: pending',
  ]);
});

// The pulse lives in the stylesheet, only under prefers-reduced-motion: no-preference; the
// component marks which segment is the active one.
test('marks only the active step, and pulses it only where motion is allowed', () => {
  const { container } = render(<StepStrip steps={STEPS} />);
  expect(container.querySelectorAll('[data-status="active"]')).toHaveLength(1);
  const pulse = css.indexOf("[data-status='active'] {\n    animation");
  const gate = css.indexOf('@media (prefers-reduced-motion: no-preference)');
  expect(gate).toBeGreaterThan(-1);
  expect(pulse).toBeGreaterThan(gate);
  expect(css.slice(0, gate)).not.toContain('animation');
});

test('reads hues only through the tone hook and keeps every edge in forced colours', () => {
  expect(css).toMatch(/\.step\s*\{[^}]*background:\s*var\(--tone\)/);
  expect(css).not.toMatch(/var\(--(red|amber|green|blue|gray)\)/);
  const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
  expect(forced).toMatch(/\.step\s*\{[^}]*border:\s*1px solid CanvasText/);
});

test('joins a caller class onto the list and draws nothing for no steps', () => {
  const { container } = render(<StepStrip steps={[]} className="waves" />);
  const list = container.querySelector('ol');
  expect(list?.classList.contains('waves')).toBe(true);
  expect(segments(container)).toHaveLength(0);
});
