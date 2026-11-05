import type { TaskDoc } from '@dispatch-foo/core/browser';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import type { WorkMilestoneOptions } from '../../lib/milestoneSession';
import { DispatchDialog } from './DispatchDialog';

function task(id: string, writes: string[] = [`src/${id}.ts`]): TaskDoc {
  return {
    meta: { id, title: `Task ${id}`, status: 'ready', writes },
    body: '',
  } as unknown as TaskDoc;
}

const twelve = Array.from({ length: 12 }, (_, i) => task(`t-${i + 1}`));
const allTwelve = new Set(twelve.map((t) => t.meta.id));

function mount(
  overrides: Partial<React.ComponentProps<typeof DispatchDialog>> = {}
) {
  const confirmed: WorkMilestoneOptions[] = [];
  let cancelled = 0;
  render(
    <DispatchDialog
      title="Send agents · Payments"
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

// Confirm marks the dialog busy until onConfirm settles; waiting for the button to
// re-enable lets that promise's catch/finally render before the assertions run.
async function confirmAndSettle(button: HTMLElement) {
  fireEvent.click(button);
  await waitFor(() => {
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
}

// The concurrency is a native select: its options are in the DOM without opening it.
function concurrencyOptions(): HTMLOptionElement[] {
  const select = screen.getByRole<HTMLSelectElement>('combobox', {
    name: 'Concurrency',
  });
  return within(select).getAllByRole<HTMLOptionElement>('option');
}

describe('DispatchDialog', () => {
  test('is a modal sheet named by its title, with focus inside on the concurrency', () => {
    mount();
    const dialog = screen.getByRole('dialog', {
      name: 'Send agents · Payments',
    });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('data-slot')).toBe('dispatch-dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByRole('combobox', { name: 'Concurrency' })
    );
  });

  test('Escape cancels', () => {
    const { cancelled } = mount();
    const focused = document.activeElement ?? document.body;
    fireEvent.keyDown(focused, { key: 'Escape' });
    expect(cancelled()).toBe(1);
  });

  test('offers concurrency up to the configured cap', () => {
    mount();
    const options = concurrencyOptions();
    expect(options).toHaveLength(16);
    expect(options[0]?.textContent).toBe('1');
    expect(options[15]?.textContent).toBe('16');
  });

  test('never offers above the hard cap, even when the caller asks', () => {
    mount({ maxConcurrency: 500, defaultConcurrency: 200 });
    expect(concurrencyOptions()).toHaveLength(32);
  });

  test('a changed concurrency reprices the plan and is what confirm sends', async () => {
    const { confirmed, confirmButton, description } = mount();
    expect(description()?.textContent).toContain(
      '3 at a time · 3 start now · 9 queue ·'
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Concurrency' }), {
      target: { value: '5' },
    });
    expect(description()?.textContent).toContain(
      '5 at a time · 5 start now · 7 queue ·'
    );
    await confirmAndSettle(confirmButton());
    expect(confirmed[0]?.concurrency).toBe(5);
  });

  test('defaults the ceilings from the task count and the estimate', () => {
    const { spend, runs, description } = mount();
    expect(spend().value).toBe('120');
    expect(runs().value).toBe('12');
    expect(description()?.textContent).toEndWith(
      '~$60–$180 at $5–15 per run · ceiling $120'
    );
    expect(description()?.getAttribute('data-over-ceiling')).toBeNull();
    expect(description()?.getAttribute('data-tone')).toBeNull();
  });

  test('a ceiling under the low estimate turns the sentence amber and says so', () => {
    const { spend, description, confirmButton } = mount();
    fireEvent.change(spend(), { target: { value: '50' } });
    expect(description()?.textContent).toEndWith(
      'ceiling $50 — above the ceiling'
    );
    expect(description()?.getAttribute('data-tone')).toBe('warning');
    expect(description()?.getAttribute('data-over-ceiling')).toBe('true');
    // Still allowed: the ceiling pauses the session, which Resume can raise.
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(false);
  });

  test('a ceiling the daemon would reject blocks the confirm instead of lifting it', () => {
    const { spend, runs, description, confirmButton } = mount();
    for (const value of ['-5', '0']) {
      fireEvent.change(spend(), { target: { value } });
      expect(spend().getAttribute('aria-invalid')).toBe('true');
      expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
      expect(
        screen.getByText('More than $0, or empty for no ceiling')
      ).toBeDefined();
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
    await confirmAndSettle(confirmButton());
    expect(confirmed).toEqual([
      { concurrency: 3, maxSpendUsd: 50, maxRuns: 12 },
    ]);
  });

  test('clearing a ceiling lifts it', async () => {
    const { confirmed, spend, runs, confirmButton } = mount();
    fireEvent.change(spend(), { target: { value: '' } });
    fireEvent.change(runs(), { target: { value: '' } });
    await confirmAndSettle(confirmButton());
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

  test('lists every task with its status glyph, id and disposition', () => {
    mount({ readyIds: new Set(['t-1', 't-2', 't-3', 't-4']) });
    const list = screen.getByRole('list', { name: 'Tasks to dispatch' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(12);
    expect(rows.map((row) => row.getAttribute('data-disposition'))).toEqual([
      ...Array<string>(3).fill('starts-now'),
      'queued',
      ...Array<string>(8).fill('not-ready'),
    ]);
    const first = rows[0];
    if (first === undefined) throw new Error('no first row');
    expect(
      within(first).getByRole('img', { name: 'Status: ready' })
    ).toBeDefined();
    expect(within(first).getByText('Task t-1')).toBeDefined();
    expect(within(first).getByText('t-1')).toBeDefined();
    expect(within(first).getByText('Starts now')).toBeDefined();
    expect(within(rows[3] ?? first).getByText('Queued')).toBeDefined();
  });

  // The disposition chips keep the status table's hues: starting now is in progress (blue),
  // queued is inactive (grey), and a task that cannot start is blocked (amber), told in
  // words as well as tone.
  test('each disposition chip carries its status tone', () => {
    mount({ readyIds: new Set(['t-1', 't-2', 't-3', 't-4']) });
    const toneOf = (word: string) =>
      screen
        .getAllByText(word)[0]
        ?.closest('[data-tone]')
        ?.getAttribute('data-tone');
    expect(toneOf('Starts now')).toBe('info');
    expect(toneOf('Queued')).toBe('muted');
    expect(toneOf('Cannot start')).toBe('warning');
  });

  test('a teammate’s task shows a muted Teammate chip and is not sent', () => {
    const { confirmButton } = mount({
      readyIds: new Set(['t-1', 't-2']),
      holderOf: (t) => (t.meta.id === 't-2' ? 'human:sam' : null),
    });
    const row = document.querySelector<HTMLElement>(
      '[data-disposition="teammate"]'
    );
    expect(row?.textContent).toContain('t-2');
    expect(row?.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe(
      'muted'
    );
    expect(row?.textContent).toContain('Teammate');
    expect(confirmButton().textContent).toContain('Send 1 agent');
  });

  test('a live claim on a task’s files is a warning note that names whose run', () => {
    mount({
      liveClaims: [
        {
          runId: 'r-9',
          taskId: 't-99',
          dispatchedBy: 'human:wyat',
          claims: ['src/t-1.ts'],
        },
      ],
    });
    const note = screen.getByRole('note');
    expect(note.getAttribute('data-tone')).toBe('warning');
    expect(note.textContent).toContain(
      "Task t-1 writes files wyat's run r-9 has claimed — it will start anyway"
    );
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
    expect(
      screen.queryByRole('list', { name: 'Tasks to dispatch' })
    ).toBeNull();
    // Concurrency is not what a raise edits, so the picker goes too, and the sentence
    // prices the session against its ceiling rather than counting starts.
    expect(screen.queryByRole('combobox', { name: 'Concurrency' })).toBeNull();
    // With no concurrency to edit, focus opens on the spend ceiling.
    expect(document.activeElement).toBe(spend());
    expect(description()?.textContent).toBe(
      '~$60–$180 at $5–15 per run · ceiling $60'
    );
    expect(spend().value).toBe('60');
    expect(runs().value).toBe('');
    // Nothing changed yet, so there is nothing to raise.
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(spend(), { target: { value: '150' } });
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(false);
    await confirmAndSettle(confirmButton());
    expect(confirmed).toEqual([
      { concurrency: 4, maxSpendUsd: 150, maxRuns: null },
    ]);
  });

  test('a failed confirm surfaces the error and keeps the dialog open', async () => {
    const { confirmButton, cancelled } = mount({
      onConfirm: () => Promise.reject(new Error('daemon offline')),
    });
    await confirmAndSettle(confirmButton());
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('daemon offline');
    expect(alert.getAttribute('data-tone')).toBe('danger');
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(cancelled()).toBe(0);
  });

  test('the error sits above the task list, so a long list never hides it', async () => {
    const many = Array.from({ length: 40 }, (_, i) => task(`t-${i + 1}`));
    const { confirmButton } = mount({
      tasks: many,
      readyIds: new Set(many.map((t) => t.meta.id)),
      onConfirm: () => Promise.reject(new Error('daemon offline')),
    });
    await confirmAndSettle(confirmButton());
    const alert = screen.getByRole('alert');
    const list = screen.getByRole('list', { name: 'Tasks to dispatch' });
    expect(
      alert.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  test('the confirm is busy while onConfirm runs', async () => {
    let release: () => void = () => {};
    const { confirmButton } = mount({
      onConfirm: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const button = confirmButton();
    fireEvent.click(button);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toBe('Sending…');
    release();
    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
    expect(button.textContent).toContain('Send 12 agents');
  });

  test('cancel calls back', () => {
    const { cancelled } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelled()).toBe(1);
  });
});
