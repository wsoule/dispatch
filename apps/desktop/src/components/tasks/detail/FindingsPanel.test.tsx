import type { AdjudicateFindingInput, Finding } from '@dispatch/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { FindingsPanel } from './FindingsPanel';

const classesOf = (el: Element | null) =>
  (el?.getAttribute('class') ?? '').split(/\s+/);

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: 'f-1',
    taskId: 't-1',
    runId: null,
    severity: 'minor',
    verdict: 'open',
    title: 'Title',
    detail: 'Detail',
    file: null,
    line: null,
    ruling: null,
    round: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    raisedBy: 'agent:reviewer',
    ...overrides,
  };
}

const noop = () => Promise.resolve();

// Severity is a 24px label pill with a coloured dot, sentence case, ordered
// most severe first; the heading's trailing text names the mix.
test('groups open findings under severity pills with a dot', () => {
  const { container } = render(
    <FindingsPanel
      findings={[
        finding({ id: 'f-1', severity: 'minor', title: 'Nit' }),
        finding({ id: 'f-2', severity: 'critical', title: 'Data loss' }),
        finding({ id: 'f-3', severity: 'critical', verdict: 'addressed' }),
      ]}
      needsRuling={false}
      onAdjudicate={noop}
    />
  );
  expect(screen.getByText('Findings')).toBeDefined();
  expect(screen.getByText('2 open (1 critical, 1 minor)')).toBeDefined();
  const pills = container.querySelectorAll('[data-slot="label-pill"]');
  expect(Array.from(pills, (p) => p.textContent)).toEqual([
    'Critical',
    'Minor',
  ]);
  const critical = pills[0] as HTMLElement;
  expect(classesOf(critical)).toContain('h-6');
  const dot = critical.querySelector<HTMLElement>('span[aria-hidden]');
  expect(dot?.style.backgroundColor).toBe('var(--red)');
  expect(screen.queryByText(/CRITICAL/)).toBeNull();
});

// A finding is a comment card; a file location keeps mono because it is code.
test('renders each finding as a comment card with a mono file path', () => {
  const { container } = render(
    <FindingsPanel
      findings={[
        finding({ id: 'f-1', file: 'src/app.ts', line: 12, title: 'Leak' }),
      ]}
      needsRuling={false}
      onAdjudicate={noop}
    />
  );
  const card = container.querySelector('[data-slot="finding-card"]');
  const classes = classesOf(card);
  expect(classes).toContain('bg-surface-quaternary');
  expect(classes).toContain('rounded-card');
  expect(classes).toContain('border-[0.5px]');
  const path = screen.getByText('src/app.ts:12');
  expect(classesOf(path)).toContain('font-mono');
  expect(container.querySelector('[data-slot="adjudicate-form"]')).toBeNull();
});

// The ruling form only attaches while the loop is capped: two pill buttons,
// `Block` in red text rather than a filled destructive button, both disabled
// until a ruling is typed.
test('adjudicates with Park and Block pill buttons once a ruling is typed', async () => {
  const calls: [string, AdjudicateFindingInput][] = [];
  const { container } = render(
    <FindingsPanel
      findings={[finding({ id: 'f-9' })]}
      needsRuling
      onAdjudicate={(id, input) => {
        calls.push([id, input]);
        return Promise.resolve();
      }}
    />
  );
  expect(
    container.querySelector('[data-slot="adjudicate-form"]')
  ).not.toBeNull();
  const park = screen.getByRole('button', { name: 'Park' });
  const block = screen.getByRole('button', { name: 'Block' });
  for (const button of [park, block]) {
    expect(classesOf(button)).toContain('h-7');
    expect(classesOf(button)).toContain('rounded-control');
    expect(button.hasAttribute('disabled')).toBe(true);
  }
  expect(classesOf(block)).toContain('text-red');
  expect(classesOf(block)).not.toContain('bg-red');

  fireEvent.change(screen.getByLabelText('Ruling'), {
    target: { value: '  Known and accepted  ' },
  });
  expect(park.hasAttribute('disabled')).toBe(false);
  fireEvent.click(block);
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toEqual([
    'f-9',
    { verdict: 'blocked', ruling: 'Known and accepted' },
  ]);
});

test('renders nothing when no finding is open', () => {
  const { container } = render(
    <FindingsPanel
      findings={[finding({ verdict: 'parked' })]}
      needsRuling={false}
      onAdjudicate={noop}
    />
  );
  expect(container.firstElementChild).toBeNull();
});
