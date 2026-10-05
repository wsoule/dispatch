import type { TaskDoc } from '@dispatch-foo/core/browser';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import type { WorkEpicOptions } from '../../lib/epicSession';
import { DispatchDialog } from './DispatchDialog';

function task(id: string, writes: string[] = [`src/${id}.ts`]): TaskDoc {
  return {
    meta: { id, title: `Task ${id}`, writes },
    body: '',
  } as unknown as TaskDoc;
}

const twelve = Array.from({ length: 12 }, (_, i) => task(`t-${i + 1}`));
const allTwelve = new Set(twelve.map((t) => t.meta.id));

function mount(
  overrides: Partial<React.ComponentProps<typeof DispatchDialog>> = {}
) {
  const confirmed: WorkEpicOptions[] = [];
  let cancelled = 0;
  render(
    <DispatchDialog
      title="Send agents at this milestone"
      tasks={twelve}
      readyIds={allTwelve}
      runningNow={0}
      defaultConcurrency={3}
      maxConcurrency={16}
      onConfirm={(opts) => {
        confirmed.push(opts);
        return Promise.resolve();
      }}
      onCancel={() => {
        cancelled += 1;
      }}
      {...overrides}
    />
  );
  return {
    confirmed,
    cancelled: () => cancelled,
    description: () => document.querySelector('[data-slot=dialog-description]'),
    spend: () => screen.getByLabelText<HTMLInputElement>('Spend ceiling'),
    runs: () => screen.getByLabelText<HTMLInputElement>('Max runs'),
    confirmButton: () =>
      screen.getByRole('button', {
        name: overrides.confirmLabel ?? /Send \d+ agents?|Raise ceiling/,
      }),
  };
}

function openConcurrency() {
  fireEvent.click(screen.getByRole('combobox', { name: 'Concurrency' }));
}

describe('DispatchDialog', () => {
  test('offers concurrency up to the configured cap', () => {
    mount();
    openConcurrency();
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(16);
    expect(options[0]?.textContent).toBe('1');
    expect(options[15]?.textContent).toBe('16');
  });

  test('never offers above the hard cap, even when the caller asks', () => {
    mount({ maxConcurrency: 500, defaultConcurrency: 200 });
    openConcurrency();
    expect(screen.getAllByRole('option')).toHaveLength(32);
  });

  test('defaults the ceilings from the task count and the estimate', () => {
    const { spend, runs, description } = mount();
    expect(spend().value).toBe('120');
    expect(runs().value).toBe('12');
    expect(description()?.textContent).toEndWith(
      '~$60–$180 at $5–15 per run · ceiling $120'
    );
    expect(description()?.getAttribute('data-over-ceiling')).toBeNull();
  });

  test('a ceiling under the low estimate turns the sentence amber and says so', () => {
    const { spend, description } = mount();
    fireEvent.change(spend(), { target: { value: '50' } });
    expect(description()?.textContent).toEndWith(
      'ceiling $50 — above the ceiling'
    );
    expect(description()?.classList.contains('text-(--state-waiting-fg)')).toBe(
      true
    );
    expect(description()?.getAttribute('data-over-ceiling')).toBe('true');
  });

  test('a ceiling the daemon would reject blocks the confirm instead of lifting it', () => {
    const { spend, runs, description, confirmButton } = mount();
    for (const value of ['-5', '0']) {
      fireEvent.change(spend(), { target: { value } });
      expect(spend().getAttribute('aria-invalid')).toBe('true');
      expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
      // The sentence never claims "no ceiling" for a value that was not accepted.
      expect(description()?.getAttribute('data-over-ceiling')).toBeNull();
      expect(description()?.textContent).not.toContain('ceiling');
    }
    fireEvent.change(spend(), { target: { value: '55' } });
    expect(spend().getAttribute('aria-invalid')).toBeNull();
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(false);

    for (const value of ['0', '2.5', '-1']) {
      fireEvent.change(runs(), { target: { value } });
      expect(runs().getAttribute('aria-invalid')).toBe('true');
      expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.change(runs(), { target: { value: '3' } });
    expect(runs().getAttribute('aria-invalid')).toBeNull();
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(false);
  });

  // A browser reports `''` for text typed into a number input and flags `badInput`;
  // happy-dom only does the first half, so the flag is stubbed.
  test('unparseable text is not mistaken for an empty ceiling', () => {
    const { spend, confirmButton } = mount();
    const field = spend();
    Object.defineProperty(field, 'validity', {
      configurable: true,
      value: { badInput: true },
    });
    fireEvent.change(field, { target: { value: '' } });
    expect(field.value).toBe('');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
  });

  test('tasks without declared writes get the one-at-a-time hint', () => {
    mount({
      tasks: [
        ...twelve.slice(0, 9),
        task('t-10', []),
        task('t-11', []),
        task('t-12', []),
      ],
    });
    expect(
      screen.getByText(
        '3 tasks declare no writes — they will run one at a time'
      )
    ).toBeDefined();
  });

  test('says review rounds share the slots when fixLoop.auto is on', () => {
    mount({ fixLoopAuto: true });
    expect(
      screen.getByText('Review rounds share these slots (fixLoop.auto is on)')
    ).toBeDefined();
  });

  test('says reviews start by hand when fixLoop.auto is off', () => {
    mount({ fixLoopAuto: false });
    expect(
      screen.getByText('Reviews start by hand (fixLoop.auto is off)')
    ).toBeDefined();
  });

  test('says nothing about reviews when the caller does not know', () => {
    mount();
    expect(screen.queryByText(/fixLoop\.auto/)).toBeNull();
  });

  test('a large fan-out is told the ceiling, not the list, ends it', () => {
    const many = Array.from({ length: 100 }, (_, i) => task(`t-${i}`));
    mount({ tasks: many, readyIds: new Set(many.map((t) => t.meta.id)) });
    expect(
      screen.getByText(
        'Large fan-out — the ceiling pauses it, Resume raises it'
      )
    ).toBeDefined();
  });

  test('confirming sends the concurrency and both ceilings', async () => {
    const { confirmed, spend, confirmButton } = mount();
    expect(confirmButton().textContent).toContain('Send 12 agents');
    fireEvent.change(spend(), { target: { value: '50' } });
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(confirmed).toEqual([
      { concurrency: 3, maxSpendUsd: 50, maxRuns: 12 },
    ]);
  });

  test('clearing a ceiling lifts it', async () => {
    const { confirmed, spend, runs, confirmButton } = mount();
    fireEvent.change(spend(), { target: { value: '' } });
    fireEvent.change(runs(), { target: { value: '' } });
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(confirmed).toEqual([
      { concurrency: 3, maxSpendUsd: null, maxRuns: null },
    ]);
  });

  test('the button counts only the agents that will run', () => {
    const { confirmButton } = mount({
      readyIds: new Set(['t-1', 't-2', 't-3', 't-4', 't-5']),
    });
    expect(confirmButton().textContent).toContain('Send 5 agents');
    expect(screen.getAllByText('Cannot start')).toHaveLength(7);
  });

  test('one agent reads in the singular', () => {
    const { confirmButton } = mount({ readyIds: new Set(['t-1']) });
    expect(confirmButton().textContent).toContain('Send 1 agent');
    expect(confirmButton().textContent).not.toContain('agents');
  });

  test('nothing to send disables the button', () => {
    const { confirmButton } = mount({ readyIds: new Set() });
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
  });

  test('a caller can name the button', () => {
    const { confirmButton } = mount({ confirmLabel: 'Resume' });
    expect(confirmButton().textContent).toContain('Resume');
  });

  test('raise mode edits a paused session’s ceilings and hides the list', async () => {
    const { confirmed, spend, runs, description, confirmButton } = mount({
      mode: 'raise',
      initial: { concurrency: 4, maxSpendUsd: 60, maxRuns: null },
    });
    expect(confirmButton().textContent).toContain('Raise ceiling');
    expect(screen.queryByRole('table')).toBeNull();
    // Concurrency is not what a raise edits, so the picker goes too, and the sentence
    // prices the session against its ceiling rather than counting starts.
    expect(screen.queryByRole('combobox', { name: 'Concurrency' })).toBeNull();
    expect(description()?.textContent).toBe(
      '~$60–$180 at $5–15 per run · ceiling $60'
    );
    expect(spend().value).toBe('60');
    expect(runs().value).toBe('');
    // Nothing changed yet, so there is nothing to raise.
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(spend(), { target: { value: '150' } });
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(confirmed).toEqual([
      { concurrency: 4, maxSpendUsd: 150, maxRuns: null },
    ]);
  });

  test('a failed confirm surfaces the error and keeps the dialog open', async () => {
    const { confirmButton, cancelled } = mount({
      onConfirm: () => Promise.reject(new Error('daemon offline')),
    });
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(screen.getByRole('alert').textContent).toBe('daemon offline');
    expect(cancelled()).toBe(0);
  });

  test('cancel calls back', () => {
    const { cancelled } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelled()).toBe(1);
  });
});
