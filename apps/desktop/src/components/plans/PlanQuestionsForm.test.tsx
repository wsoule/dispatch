import type { PlannerQuestion } from '@dispatch/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import { PlanQuestionsForm } from './PlanQuestionsForm';

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
