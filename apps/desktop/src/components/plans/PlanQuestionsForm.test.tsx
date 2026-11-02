import type { PlannerQuestion } from '@dispatch/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import decisionStyles from '../gates/DecisionCard.module.css';
import { PlanQuestionsForm } from './PlanQuestionsForm';

// A CSS module's rules, comments dropped.
function moduleCss(path: string): string {
  return readFileSync(join(import.meta.dir, path), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  );
}
const decisionCss = moduleCss('../gates/DecisionCard.module.css');
const ownCss = moduleCss('PlanQuestionsForm.module.css');

/** The declarations of the first `selector {…}` rule in DecisionCard's module. */
function rule(selector: string): string {
  const at = decisionCss.indexOf(`\n${selector} {`);
  expect([selector, at >= 0]).toEqual([selector, true]);
  return decisionCss.slice(at, decisionCss.indexOf('}', at));
}

const Q1: PlannerQuestion = {
  id: 'q1',
  question: 'Should this cover the mobile app too?',
  options: [],
};

describe('PlanQuestionsForm', () => {
  // onSend resolves on the server's 202 accept, not on the answering turn settling — a
  // failed turn is invisible to this promise and only shows up as the SAME question set
  // still being on the record afterward. That's the exact case the answers must survive.
  test('keeps the typed answers when the accepted turn fails and the same questions persist', async () => {
    const onSend = () => Promise.resolve();
    render(
      <PlanQuestionsForm questions={[Q1]} disabled={false} onSend={onSend} />
    );

    const textarea = screen.getByLabelText<HTMLTextAreaElement>(Q1.question);
    fireEvent.change(textarea, { target: { value: 'Desktop only, please' } });
    fireEvent.click(screen.getByRole('button', { name: /send answers/i }));

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /send answers/i }).textContent
      ).not.toBe('Sending…')
    );

    expect(screen.getByLabelText<HTMLTextAreaElement>(Q1.question).value).toBe(
      'Desktop only, please'
    );
  });

  test('resets the fields when a genuinely new question set arrives (same id, different text)', () => {
    const onSend = () => Promise.resolve();
    const { rerender } = render(
      <PlanQuestionsForm questions={[Q1]} disabled={false} onSend={onSend} />
    );

    const textarea = screen.getByLabelText<HTMLTextAreaElement>(Q1.question);
    fireEvent.change(textarea, { target: { value: 'Desktop only, please' } });
    expect(textarea.value).toBe('Desktop only, please');

    const Q1_AGAIN: PlannerQuestion = {
      id: 'q1',
      question: 'Any deadline we should plan around?',
      options: [],
    };
    rerender(
      <PlanQuestionsForm
        questions={[Q1_AGAIN]}
        disabled={false}
        onSend={onSend}
      />
    );

    expect(
      screen.getByLabelText<HTMLTextAreaElement>(Q1_AGAIN.question).value
    ).toBe('');
  });
});

describe('PlanQuestionsForm chrome', () => {
  // happy-dom applies no stylesheet and bun maps CSS module classes to nothing, so
  // the heading's look is read from DecisionCard's own module: the heading is its
  // `.question` element (the id the card names its answers by), 12px medium in the
  // warning tone's ink, never uppercase.
  test('the heading is DecisionCard’s 12px medium sentence-case question on a warning tint', () => {
    render(
      <PlanQuestionsForm
        questions={[Q1]}
        disabled={false}
        onSend={() => Promise.resolve()}
      />
    );
    const heading = screen.getByText('The planner is asking you');
    expect(heading.textContent).toBe('The planner is asking you');
    expect(heading.classList.contains('eyebrow')).toBe(false);
    expect(heading.id).not.toBe('');
    expect(heading.className).toBe(decisionStyles.question ?? '');
    const card = heading.closest('[data-tone]');
    expect(card?.getAttribute('data-tone')).toBe('warning');
    const question = rule('.question');
    expect(question).toContain('font-size: 12px;');
    expect(question).toContain('font-weight: var(--fw-medium);');
    expect(rule('.toned .question')).toContain('color: var(--tone-ink);');
    expect(decisionCss).not.toContain('text-transform');
  });

  test('a failed send reads in the danger tone, not a raw hue', async () => {
    render(
      <PlanQuestionsForm
        questions={[Q1]}
        disabled={false}
        onSend={() => Promise.reject(new Error('the planner is busy'))}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /send answers/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('the planner is busy');
    expect(alert.classList.contains('toneText')).toBe(true);
    expect(alert.getAttribute('data-tone')).toBe('danger');
    expect(ownCss).not.toContain('var(--red)');
  });
});
