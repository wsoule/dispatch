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

// The chips directly under the pill's root: the state chip, then the disposition chip.
function chips(root: Element | null): HTMLElement[] {
  if (root === null) return [];
  return Array.from(root.children).filter(
    (el): el is HTMLElement =>
      el instanceof HTMLElement && el.dataset['tone'] !== undefined
  );
}

describe('RunStatePill', () => {
  test('the full variant is a state chip and a quiet disposition chip', () => {
    const { container } = render(<RunStatePill meta={run()} />);
    const root = container.querySelector<HTMLElement>(
      '[data-slot=run-state-pill]'
    );
    expect(root?.dataset['runState']).toBe('finished');
    const [state, disposition, ...rest] = chips(root);
    expect(rest).toEqual([]);
    // The state chip is neutral: the hue lives on its StateMark glyph (data-tone), never
    // as an inline colour. A finished run's review is green: the work succeeded and waits
    // on a person (plan Q6.2), not the amber of an ask.
    expect(state?.dataset['tone']).toBe('default');
    expect(state?.textContent).toBe('Review');
    const mark = state?.querySelector<HTMLElement>('[data-slot=state-mark]');
    expect(mark?.dataset['state']).toBe('review');
    expect(mark?.dataset['tone']).toBe('success');
    expect(mark?.getAttribute('width')).toBe('14');
    expect(root?.querySelector('[style*="color"]')).toBeNull();
    expect(disposition?.textContent).toBe('Needs review');
    expect(disposition?.dataset['tone']).toBe('muted');
  });

  test('a live run has no disposition chip, and its glyph pulses', () => {
    const { container } = render(
      <RunStatePill meta={run({ state: 'running' })} />
    );
    const found = chips(container.querySelector('[data-slot=run-state-pill]'));
    expect(found.length).toBe(1);
    expect(found[0]?.textContent).toBe('Working');
    expect(
      found[0]?.querySelector<HTMLElement>('[data-slot=state-mark]')?.dataset[
        'pulse'
      ]
    ).toBe('true');
  });

  // Grey for inactive (the status table): neither the failure red nor the amber of a run
  // waiting on input. The neutral disc with its bar, and no tone at all.
  test('a cancelled run reads neutral, never the failure red or an ask', () => {
    const { container } = render(
      <RunStatePill meta={run({ state: 'cancelled' })} />
    );
    const mark = container.querySelector<HTMLElement>('[data-slot=state-mark]');
    expect(mark?.dataset['state']).toBe('closed');
    expect(mark?.dataset['tone']).toBeUndefined();
    expect(container.textContent).toContain('Cancelled');
  });

  // A run a person closed out is past its state's mark: done keeps a filled neutral mark,
  // never green next to a failed run's red, and a discarded run never reads as succeeded.
  test('a merged run draws the neutral done disc, full and compact', () => {
    const merged = run({
      reviewedAt: '2026-11-02T10:00:00.000Z',
      reviewAction: 'merge',
    });
    const { container } = render(
      <>
        <RunStatePill meta={merged} />
        <RunStatePill meta={merged} compact />
      </>
    );
    const mark = container.querySelector<HTMLElement>('[data-slot=state-mark]');
    expect(mark?.dataset['state']).toBe('done');
    expect(mark?.dataset['tone']).toBeUndefined();
    expect(container.textContent).toContain('Merged');
    const dot = screen
      .getByRole('img', { name: 'Review · Merged' })
      .querySelector<HTMLElement>('[data-slot=state-dot]');
    expect(dot?.dataset['state']).toBe('done');
    expect(dot?.dataset['tone']).toBeUndefined();
  });

  test('a discarded run, finished or failed, draws the neutral closed disc', () => {
    const { container } = render(
      <>
        <RunStatePill
          meta={run({
            reviewedAt: '2026-11-02T10:00:00.000Z',
            reviewAction: 'discard',
          })}
        />
        <RunStatePill
          meta={run({
            state: 'failed',
            reviewedAt: '2026-11-02T10:00:00.000Z',
            reviewAction: 'discard',
          })}
          compact
        />
      </>
    );
    const mark = container.querySelector<HTMLElement>('[data-slot=state-mark]');
    expect(mark?.dataset['state']).toBe('closed');
    expect(mark?.dataset['tone']).toBeUndefined();
    expect(container.textContent).toContain('Discarded');
    const dot = screen
      .getByRole('img', { name: 'Failed · Discarded' })
      .querySelector<HTMLElement>('[data-slot=state-dot]');
    expect(dot?.dataset['state']).toBe('closed');
    expect(dot?.dataset['tone']).toBeUndefined();
  });

  test('compact is the 9px status dot alone, named by state and disposition', () => {
    const { container } = render(<RunStatePill meta={run()} compact />);
    const mark = screen.getByRole('img', { name: 'Review · Needs review' });
    expect(mark.dataset['slot']).toBe('run-state-mark');
    expect(mark.dataset['runState']).toBe('finished');
    expect(mark.title).toBe('Review · Needs review');
    expect(container.querySelector('[data-slot=run-state-pill]')).toBeNull();
    const dot = mark.querySelector<HTMLElement>('[data-slot=state-dot]');
    expect(dot?.dataset['tone']).toBe('success');
    expect(dot?.dataset['pulse']).toBeUndefined();
  });

  // Awaiting approval is an ask (amber); finished is succeeded work awaiting review
  // (green). The two must never share a hue, or the pill would blur ask and result.
  test('an approval gate is amber, a finished run green', () => {
    const { container } = render(
      <>
        <RunStatePill meta={run({ state: 'awaiting-approval' })} />
        <RunStatePill meta={run()} />
      </>
    );
    const tones = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot=state-mark]'),
      (mark) => [mark.dataset['state'], mark.dataset['tone']]
    );
    expect(tones).toEqual([
      ['approve', 'warning'],
      ['review', 'success'],
    ]);
  });

  test('a compact live run is named by its state alone, and pulses', () => {
    render(<RunStatePill meta={run({ state: 'running' })} compact />);
    const mark = screen.getByRole('img', { name: 'Working' });
    expect(
      mark.querySelector<HTMLElement>('[data-slot=state-dot]')?.dataset['pulse']
    ).toBe('true');
  });
});
