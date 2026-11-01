import type { NormalizedEntry } from '@dispatch/client';
import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { WorkFold, workSpanMs } from './WorkFold';

function step(ts: string): NormalizedEntry {
  return { ts, kind: 'tool', toolName: 'Read', status: 'done' };
}

const THREE = [
  step('2026-10-25T10:00:00.000Z'),
  step('2026-10-25T10:00:05.000Z'),
  step('2026-10-25T10:00:12.000Z'),
];

test('the span runs from the first stamp to the last, skipping bad ones', () => {
  expect(workSpanMs(THREE)).toBe(12_000);
  expect(workSpanMs([step('nope'), ...THREE.slice(0, 1)])).toBe(0);
});

test('a settled group folds closed behind a Worked-for line', () => {
  render(
    <WorkFold entries={THREE} live={false}>
      <span>the rows</span>
    </WorkFold>
  );
  const trigger = screen.getByRole('button', { name: /Worked for 12s/ });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(trigger.textContent).toContain('3 steps');
});

test('a live group stays open and says Working', () => {
  render(
    <WorkFold entries={THREE} live>
      <span>the rows</span>
    </WorkFold>
  );
  const trigger = screen.getByRole('button', { name: /Working for 12s/ });
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('the rows')).toBeDefined();
});

test('a short group shows its rows with no fold', () => {
  render(
    <WorkFold entries={THREE.slice(0, 2)} live={false}>
      <span>the rows</span>
    </WorkFold>
  );
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByText('the rows')).toBeDefined();
});
