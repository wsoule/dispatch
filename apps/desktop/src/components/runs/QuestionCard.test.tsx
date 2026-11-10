import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, mock, test } from 'bun:test';

import { QuestionCard } from './QuestionCard';

function card(
  onAnswer: (answer: string) => Promise<void>,
  options: string[] = ['old', 'new']
) {
  render(
    <QuestionCard
      question="Which **schema** should it migrate to?"
      options={options}
      askedAt={new Date(Date.now() - 5 * 60_000).toISOString()}
      onAnswer={onAnswer}
    />
  );
  return screen.getByRole<HTMLTextAreaElement>('textbox', {
    name: 'Your answer',
  });
}

describe('QuestionCard', () => {
  // The question is agent-written Markdown, and the detail says how long
  // the agent has waited, in sentence case.
  test('renders the question as Markdown and says when it was asked', () => {
    card(() => Promise.resolve());
    expect(screen.getByText('schema').tagName).toBe('STRONG');
    expect(screen.getByText(/^Asked /).textContent).toMatch(/^Asked \S/);
    expect(
      screen.getByRole('radiogroup', { name: /Which schema/ })
    ).toBeTruthy();
  });

  test('a suggested answer goes out on one pick', async () => {
    const onAnswer = mock((_answer: string) => Promise.resolve());
    card(onAnswer);
    fireEvent.click(screen.getByRole('radio', { name: 'new' }));
    await waitFor(() => expect(onAnswer.mock.calls).toEqual([['new']]));
  });

  // Enter sends the trimmed draft; Shift+Enter is a new line, not a send.
  test('Enter sends the trimmed draft and Shift+Enter does not', async () => {
    const onAnswer = mock((_answer: string) => Promise.resolve());
    const box = card(onAnswer);
    fireEvent.change(box, { target: { value: '  use v3, keep v2 reads  ' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(onAnswer.mock.calls).toEqual([['use v3, keep v2 reads']])
    );
    // A sent answer clears the box.
    await waitFor(() => expect(box.value).toBe(''));
  });

  test('a blank draft sends nothing; Answer waits for words', () => {
    const onAnswer = mock((_answer: string) => Promise.resolve());
    const box = card(onAnswer, []);
    const send = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Answer',
    });
    expect(send.disabled).toBe(true);
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onAnswer).not.toHaveBeenCalled();
    expect(send.disabled).toBe(true);
  });

  test('a failed answer says why and keeps the draft', async () => {
    const onAnswer = mock((_answer: string) =>
      Promise.reject(new Error('the run already ended'))
    );
    const box = card(onAnswer);
    fireEvent.change(box, { target: { value: 'v3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'the run already ended'
    );
    expect(box.value).toBe('v3');
  });
});
