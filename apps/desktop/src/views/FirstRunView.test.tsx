import type { DraftRecord } from '@dispatch/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { FirstRunView } from './FirstRunView';

const draft = {} as DraftRecord;

function setup(
  over: Partial<{
    onStartDraft: (prompt: string) => Promise<DraftRecord>;
    onBrowseBoard: () => void;
  }> = {}
) {
  const onStartDraft = over.onStartDraft ?? mock(() => Promise.resolve(draft));
  const onBrowseBoard = over.onBrowseBoard ?? mock(() => {});
  render(
    <FirstRunView
      projectName="dispatch"
      onStartDraft={onStartDraft}
      onBrowseBoard={onBrowseBoard}
    />
  );
  return { onStartDraft, onBrowseBoard };
}

function box() {
  return screen.getByLabelText('What do you want to change?');
}

test('names the project it is about to change', () => {
  setup();
  expect(
    screen.getByText(/What do you want to change in dispatch\?/)
  ).toBeTruthy();
});

test('drafts from the typed prompt', async () => {
  const { onStartDraft } = setup();

  fireEvent.change(box(), { target: { value: '  add a dark mode toggle  ' } });
  fireEvent.click(screen.getByText('Draft task'));

  // Trimmed: leading and trailing whitespace is never part of the request.
  await waitFor(() =>
    expect(onStartDraft).toHaveBeenCalledWith('add a dark mode toggle')
  );
});

test('Enter drafts and Shift+Enter does not', async () => {
  const { onStartDraft } = setup();
  fireEvent.change(box(), { target: { value: 'do the thing' } });

  fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
  expect(onStartDraft).not.toHaveBeenCalled();

  fireEvent.keyDown(box(), { key: 'Enter' });
  await waitFor(() => expect(onStartDraft).toHaveBeenCalledTimes(1));
});

test('an empty box cannot be submitted', () => {
  const { onStartDraft } = setup();

  fireEvent.change(box(), { target: { value: '   ' } });
  fireEvent.keyDown(box(), { key: 'Enter' });

  expect(onStartDraft).not.toHaveBeenCalled();
});

test('a failed draft keeps the prompt on screen with the reason', async () => {
  // Losing what someone just typed because the daemon hiccuped is the worst
  // possible first impression.
  setup({
    onStartDraft: mock(() => Promise.reject(new Error('daemon unreachable'))),
  });

  fireEvent.change(box(), { target: { value: 'do the thing' } });
  fireEvent.keyDown(box(), { key: 'Enter' });

  await screen.findByRole('alert');
  expect(screen.getByText('daemon unreachable')).toBeTruthy();
  expect((box() as HTMLTextAreaElement).value).toBe('do the thing');
});

test('clears the box after a draft starts, ready for the next thought', async () => {
  setup();

  fireEvent.change(box(), { target: { value: 'do the thing' } });
  fireEvent.keyDown(box(), { key: 'Enter' });

  await waitFor(() => expect((box() as HTMLTextAreaElement).value).toBe(''));
});

test('offers a way past the prompt to the ordinary board', () => {
  const { onBrowseBoard } = setup();

  fireEvent.click(screen.getByText('Browse the board'));

  // Someone who opened the app to look around must not be stuck behind a
  // textarea.
  expect(onBrowseBoard).toHaveBeenCalled();
});

test('Two views can set the prompt aside for the agent', () => {
  const onTalkToAgent = mock(() => {});
  render(
    <FirstRunView
      projectName="dispatch"
      onStartDraft={() => Promise.resolve(draft)}
      onBrowseBoard={() => {}}
      onTalkToAgent={onTalkToAgent}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Talk to the agent' }));
  expect(onTalkToAgent).toHaveBeenCalledTimes(1);
});

test('Classic offers no agent escape', () => {
  setup();
  expect(
    screen.queryByRole('button', { name: 'Talk to the agent' })
  ).toBeNull();
});
