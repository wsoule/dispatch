import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'bun:test';

import { GLOSSARY } from '../../lib/glossary';
import { GlossaryTerm } from './GlossaryTerm';

afterEach(cleanup);

test('the term reads as itself and its hint is the glossary sentence', () => {
  render(
    <GlossaryTerm term="milestone" defaultOpen>
      Milestones
    </GlossaryTerm>
  );
  const term = screen.getByText('Milestones');
  expect(term.dataset['glossary']).toBe('milestone');
  expect(term.tabIndex).toBe(0);
  // The tip is aria-hidden (it renders inside the column's heading and
  // must not join its name); the term's description still reads it.
  const tip = screen.getByRole('tooltip', { hidden: true });
  expect(tip.textContent).toBe(GLOSSARY.milestone);
  expect(term.getAttribute('aria-describedby')).toBe(tip.id);
  expect(term.matches('[data-glossary]')).toBe(true);
});

test('inside a heading, the hint stays out of the heading name', () => {
  render(
    <h2>
      <GlossaryTerm term="milestone" defaultOpen>
        Milestones
      </GlossaryTerm>
    </h2>
  );
  expect(screen.getByRole('heading', { name: 'Milestones' })).toBeTruthy();
});

test('closed, nothing renders and the term describes nothing', () => {
  render(<GlossaryTerm term="milestone">Milestones</GlossaryTerm>);
  expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
  expect(screen.getByText('Milestones').hasAttribute('aria-describedby')).toBe(
    false
  );
});
