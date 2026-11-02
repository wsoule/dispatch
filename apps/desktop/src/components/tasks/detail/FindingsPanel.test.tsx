import type { AdjudicateFindingInput, Finding } from '@dispatch/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { FindingsPanel } from './FindingsPanel';

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

// Severity is a chip toned by severity (danger, warning, muted), its words in
// sentence case, ordered most severe first; the heading's meta names the mix.
test('groups open findings under severity chips toned by severity', () => {
  const { container } = render(
    <FindingsPanel
      findings={[
        finding({ id: 'f-1', severity: 'minor', title: 'Nit' }),
        finding({ id: 'f-2', severity: 'critical', title: 'Data loss' }),
        finding({ id: 'f-3', severity: 'critical', verdict: 'addressed' }),
        finding({ id: 'f-4', severity: 'important', title: 'Slow path' }),
      ]}
      needsRuling={false}
      onAdjudicate={noop}
    />
  );
  expect(screen.getByRole('heading', { name: 'Findings' })).toBeDefined();
  expect(
    screen.getByText('3 open (1 critical, 1 important, 1 minor)')
  ).toBeDefined();
  const chips = Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="label-pill"]')
  );
  expect(chips.map((c) => c.textContent)).toEqual([
    'Critical',
    'Important',
    'Minor',
  ]);
  expect(chips.map((c) => c.dataset.tone)).toEqual([
    'danger',
    'warning',
    'muted',
  ]);
  expect(screen.queryByText(/CRITICAL/)).toBeNull();
  // Each group lists its own findings under its chip.
  const groups = container.querySelectorAll('[data-slot="findings-group"]');
  expect(Array.from(groups, (g) => g.querySelectorAll('li').length)).toEqual([
    1, 1, 1,
  ]);
  expect(groups[0]?.textContent).toContain('Data loss');
  expect(groups[2]?.textContent).toContain('Nit');
});

// A finding is a comment card; a file location is set in mono because it is code.
test('renders each finding as a card with its file path in mono', () => {
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
  expect(card?.textContent).toContain('Leak');
  expect(card?.textContent).toContain('Detail');
  const path = screen.getByText('src/app.ts:12');
  expect(path.closest('.mono')).not.toBeNull();
  expect(card?.contains(path)).toBe(true);
  expect(container.querySelector('[data-slot="adjudicate-form"]')).toBeNull();
});

// The ruling form only attaches while the loop is capped: two buttons, `Block`
// in the danger tone's words rather than a filled destructive button, both
// disabled until a ruling is typed.
test('adjudicates with Park and Block once a ruling is typed', async () => {
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
    expect(button.hasAttribute('disabled')).toBe(true);
  }
  const danger = screen.getByText('Block');
  expect(danger.classList.contains('toneText')).toBe(true);
  expect(danger.getAttribute('data-tone')).toBe('danger');

  const ruling = screen.getByRole('textbox', { name: 'Ruling' });
  expect(ruling.tagName).toBe('TEXTAREA');
  fireEvent.change(ruling, {
    target: { value: '  Known and accepted  ' },
  });
  expect(park.hasAttribute('disabled')).toBe(false);
  fireEvent.click(block);
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toEqual([
    'f-9',
    { verdict: 'blocked', ruling: 'Known and accepted' },
  ]);
  await waitFor(() => expect((ruling as HTMLTextAreaElement).value).toBe(''));
});

test('parks a finding with the typed ruling', async () => {
  const calls: [string, AdjudicateFindingInput][] = [];
  render(
    <FindingsPanel
      findings={[finding({ id: 'f-7' })]}
      needsRuling
      onAdjudicate={(id, input) => {
        calls.push([id, input]);
        return Promise.resolve();
      }}
    />
  );
  fireEvent.change(screen.getByLabelText('Ruling'), {
    target: { value: 'Out of scope' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Park' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toEqual([
    'f-7',
    { verdict: 'parked', ruling: 'Out of scope' },
  ]);
});

test('says why a ruling failed, in the danger tone', async () => {
  render(
    <FindingsPanel
      findings={[finding({ id: 'f-8' })]}
      needsRuling
      onAdjudicate={() => Promise.reject(new Error('daemon offline'))}
    />
  );
  fireEvent.change(screen.getByLabelText('Ruling'), {
    target: { value: 'Accepted' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Park' }));
  const error = await screen.findByText('daemon offline');
  expect(error.classList.contains('toneText')).toBe(true);
  expect(error.getAttribute('data-tone')).toBe('danger');
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
