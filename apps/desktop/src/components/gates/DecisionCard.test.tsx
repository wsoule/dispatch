import { fireEvent, render, screen } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DecisionCard } from './DecisionCard';

// The module's rules, comments dropped.
const css = readFileSync(
  join(import.meta.dir, 'DecisionCard.module.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first `selector {…}` rule in the module. */
function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect([selector, at >= 0]).toEqual([selector, true]);
  return css.slice(at, css.indexOf('}', at));
}

const OPTIONS = [
  { id: 'approve', label: 'Approve', recommended: true },
  { id: 'reject', label: 'Reject', description: 'The agent stops here.' },
];

test('the answers are radios named after their labels, in a group named by the question', () => {
  render(
    <DecisionCard
      question="Merge the branch?"
      detail="feature/login"
      options={[
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ]}
    />
  );
  const group = screen.getByRole('radiogroup', { name: 'Merge the branch?' });
  const heading = document.getElementById(
    group.getAttribute('aria-labelledby') ?? ''
  );
  expect(heading?.textContent).toBe('Merge the branch?');
  expect(heading?.tagName).toBe('DIV');
  expect(screen.getByRole('radio', { name: 'Approve' })).toBeDefined();
  expect(screen.getByRole('radio', { name: 'Reject' })).toBeDefined();
  expect(screen.getByText('feature/login')).toBeDefined();
});

test('the recommended answer carries its chip in its name; a description describes', () => {
  render(<DecisionCard question="Merge?" options={OPTIONS} />);
  const approve = screen.getByRole('radio', { name: 'Approve Recommended' });
  expect(approve.getAttribute('value')).toBe('approve');
  expect(approve.getAttribute('aria-describedby')).toBeNull();
  const reject = screen.getByRole('radio', { name: 'Reject' });
  expect(
    document.getElementById(reject.getAttribute('aria-describedby') ?? '')
      ?.textContent
  ).toBe('The agent stops here.');
});

test('picking says "Selected — X"; a disabled card says "Answered — X"', () => {
  const onSelect = mock((_id: string) => undefined);
  const { rerender } = render(
    <DecisionCard question="Merge?" options={OPTIONS} onSelect={onSelect} />
  );
  expect(screen.queryByText(/^Selected/)).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: 'Reject' }));
  expect(onSelect.mock.calls).toEqual([['reject']]);

  rerender(
    <DecisionCard
      question="Merge?"
      options={OPTIONS}
      selectedId="reject"
      onSelect={onSelect}
    />
  );
  expect(screen.getByText(/^Selected/).textContent).toBe('Selected — Reject');
  expect(
    screen.getByRole<HTMLInputElement>('radio', { name: 'Reject' }).checked
  ).toBe(true);

  // Disabled reads as answered unless the host says otherwise.
  rerender(
    <DecisionCard
      question="Merge?"
      options={OPTIONS}
      selectedId="reject"
      onSelect={onSelect}
      disabled
    />
  );
  expect(screen.getByText(/^Answered/).textContent).toBe('Answered — Reject');
  rerender(
    <DecisionCard
      question="Merge?"
      options={OPTIONS}
      selectedId="reject"
      onSelect={onSelect}
      disabled
      answered={false}
    />
  );
  expect(screen.getByText(/^Selected/).textContent).toBe('Selected — Reject');
});

test('a disabled card or answer takes no pick', () => {
  const onSelect = mock((_id: string) => undefined);
  const { rerender } = render(
    <DecisionCard
      question="Merge?"
      options={[
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject', disabled: true },
      ]}
      onSelect={onSelect}
    />
  );
  const reject = screen.getByRole<HTMLInputElement>('radio', {
    name: 'Reject',
  });
  expect(reject.disabled).toBe(true);
  fireEvent.click(reject);
  expect(onSelect).not.toHaveBeenCalled();

  rerender(
    <DecisionCard
      question="Merge?"
      options={OPTIONS}
      onSelect={onSelect}
      disabled
    />
  );
  for (const radio of screen.getAllByRole<HTMLInputElement>('radio')) {
    expect(radio.disabled).toBe(true);
    fireEvent.click(radio);
    fireEvent.keyDown(radio, { key: 'Enter' });
  }
  expect(onSelect).not.toHaveBeenCalled();
});

// Arrowing past an answer must not pick it: these answers act at once.
test('an arrow key moves between the answers without picking', () => {
  const onSelect = mock((_id: string) => undefined);
  render(
    <DecisionCard
      question="Merge?"
      options={OPTIONS}
      selectedId="approve"
      onSelect={onSelect}
    />
  );
  const approve = screen.getByRole('radio', { name: /^Approve/ });
  const reject = screen.getByRole('radio', { name: 'Reject' });
  // What a browser does on ArrowDown: a keydown on the focused radio, a
  // click (the change) on the next one, then the keyup.
  fireEvent.keyDown(approve, { key: 'ArrowDown' });
  fireEvent.click(reject);
  fireEvent.keyUp(reject, { key: 'ArrowDown' });
  expect(onSelect).not.toHaveBeenCalled();
  // Enter picks the focused answer.
  fireEvent.keyDown(reject, { key: 'Enter' });
  expect(onSelect.mock.calls).toEqual([['reject']]);
});

test('a tone tints the card and its host hooks land on the root', () => {
  const { rerender } = render(
    <DecisionCard
      question="Wants to run"
      tone="warning"
      data-slot="plan-questions"
      data-testid="card"
      options={OPTIONS}
      actions={<button type="button">Send answers</button>}
    >
      <p>Two questions left</p>
    </DecisionCard>
  );
  const card = screen.getByTestId('card');
  expect(card.getAttribute('data-slot')).toBe('plan-questions');
  expect(card.getAttribute('data-tone')).toBe('warning');
  expect(card.textContent).toContain('Two questions left');
  // The actions come last.
  expect(card.lastElementChild?.textContent).toBe('Send answers');
  rerender(
    <DecisionCard question="Wants to run" data-testid="card" tone="default" />
  );
  expect(screen.getByTestId('card').hasAttribute('data-tone')).toBe(false);
  // No answers, no group.
  expect(screen.queryByRole('radiogroup')).toBeNull();
});

test('the heading is 12px medium sentence case in the tone ink on a tint', () => {
  render(<DecisionCard question="Wants to run" options={OPTIONS} />);
  const heading = screen.getByText('Wants to run');
  expect(heading.className).not.toContain('eyebrow');
  const question = rule('.question');
  expect(question).toContain('font-size: 12px;');
  expect(question).toContain('font-weight: var(--fw-medium);');
  expect(css).not.toContain('text-transform');
  expect(rule('.toned .question')).toContain('color: var(--tone-ink);');
  expect(rule('.toned')).toContain('background: var(--tone-soft);');
  expect(rule('.toned')).toContain('border-color: var(--tone-line);');
  // Words on a tint are ink or text, never the quietest step.
  expect(css).not.toContain('--text-3');
});
