import type { EscalationStep } from '@dispatch/core/browser';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { EscalationEditor } from './EscalationEditor';

const steps: EscalationStep[] = [
  { round: 1, strategy: 'resume', modelTier: 'standard' },
  { round: 2, strategy: 'fresh', modelTier: 'high' },
];

test('adding a step continues the round numbering', () => {
  let next: EscalationStep[] = [];
  render(<EscalationEditor steps={steps} onChange={(s) => (next = s)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
  expect(next).toHaveLength(3);
  expect(next[2]).toEqual({
    round: 3,
    strategy: 'resume',
    modelTier: 'standard',
  });
});

// Rounds are positional, so a gap after a removal would be meaningless to the
// fix loop — it reads them in order.
test('removing a middle step renumbers the rest', () => {
  let next: EscalationStep[] = [];
  render(<EscalationEditor steps={steps} onChange={(s) => (next = s)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove round 1' }));
  expect(next).toEqual([{ round: 1, strategy: 'fresh', modelTier: 'high' }]);
});

test('adding to an empty list starts at round 1', () => {
  let next: EscalationStep[] = [];
  render(<EscalationEditor steps={[]} onChange={(s) => (next = s)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
  expect(next).toEqual([
    { round: 1, strategy: 'resume', modelTier: 'standard' },
  ]);
});

// An empty ladder must say so rather than showing a bare "Add step" button
// with no explanation of what an empty list means for the fix loop.
test('an empty list explains itself instead of showing a bare Add button', () => {
  render(<EscalationEditor steps={[]} onChange={() => {}} />);
  expect(screen.getByText(/no escalation steps/i)).toBeTruthy();
});

// Removing the only remaining step must not throw and must report an empty
// array rather than leaving a stale round behind.
test('removing the last remaining step empties the list', () => {
  let next: EscalationStep[] | null = null;
  render(
    <EscalationEditor
      steps={[{ round: 1, strategy: 'resume', modelTier: 'standard' }]}
      onChange={(s) => (next = s)}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove round 1' }));
  expect(next).toEqual([]);
});

// Each row's two selects must carry an accessible name that says which round
// they belong to, not a bare "Strategy" that repeats across every row.
test('a row select carries its round in its accessible name', () => {
  render(<EscalationEditor steps={steps} onChange={() => {}} />);
  expect(
    screen.getByRole('combobox', { name: 'Round 1 strategy' })
  ).toBeTruthy();
  expect(
    screen.getByRole('combobox', { name: 'Round 2 model tier' })
  ).toBeTruthy();
});

// Changing a row's strategy select must patch only that row, in place,
// without renumbering (renumbering is reserved for add/remove).
test('changing a strategy select patches only that row', () => {
  let next: EscalationStep[] = [];
  render(<EscalationEditor steps={steps} onChange={(s) => (next = s)} />);
  fireEvent.click(screen.getByRole('combobox', { name: 'Round 1 strategy' }));
  fireEvent.click(screen.getByRole('option', { name: 'Fresh agent' }));
  expect(next).toEqual([
    { round: 1, strategy: 'fresh', modelTier: 'standard' },
    { round: 2, strategy: 'fresh', modelTier: 'high' },
  ]);
});
