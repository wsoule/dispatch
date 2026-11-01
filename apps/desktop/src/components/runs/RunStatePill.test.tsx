import type { RunMeta } from '@dispatch/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import { RunStatePill } from './RunStatePill';

// Only the fields the pill reads: the state, plus what deriveRunDisposition needs to tell
// a finished run awaiting review from one a human already closed out.
function run(over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-abc123',
    taskId: 't-abc123',
    state: 'finished',
    branch: 'dispatch/t-abc123',
    baseBranch: 'main',
    ...over,
  } as RunMeta;
}

describe('RunStatePill', () => {
  test('the full variant is a state pill and a neutral disposition pill', () => {
    const { container } = render(<RunStatePill meta={run()} />);
    const root = container.querySelector<HTMLElement>(
      '[data-slot=run-state-pill]'
    );
    expect(root?.dataset['runState']).toBe('finished');
    const pills = root?.querySelectorAll('[data-slot=pill]') ?? [];
    expect(pills.length).toBe(2);
    expect(pills[0]?.className).toContain('h-6');
    expect(pills[0]?.textContent).toBe('Review');
    expect(pills[0]?.querySelector('svg')?.classList.contains('size-3.5')).toBe(
      true
    );
    expect(pills[1]?.textContent).toBe('Needs review');
    expect(pills[1]?.className).toContain('text-muted-foreground');
  });

  test('a live run has no disposition pill', () => {
    const { container } = render(
      <RunStatePill meta={run({ state: 'running' })} />
    );
    const pills = container.querySelectorAll('[data-slot=pill]');
    expect(pills.length).toBe(1);
    expect(pills[0]?.textContent).toBe('Working');
  });

  test('compact is the 9px status dot alone, named by state and disposition', () => {
    const { container } = render(<RunStatePill meta={run()} compact />);
    const mark = screen.getByRole('img', { name: 'Review · Needs review' });
    expect(mark.dataset['slot']).toBe('run-state-mark');
    expect(mark.dataset['runState']).toBe('finished');
    expect(mark.title).toBe('Review · Needs review');
    expect(container.querySelector('[data-slot=pill]')).toBeNull();
    const dot = mark.querySelector('[data-slot=state-dot]');
    expect(dot?.classList.contains('size-[9px]')).toBe(true);
    expect(dot?.className).not.toContain('animate-status-pulse');
  });

  test('a compact live run is named by its state alone, and pulses', () => {
    render(<RunStatePill meta={run({ state: 'running' })} compact />);
    const mark = screen.getByRole('img', { name: 'Working' });
    expect(mark.querySelector('[data-slot=state-dot]')?.className).toContain(
      'animate-status-pulse'
    );
  });
});
