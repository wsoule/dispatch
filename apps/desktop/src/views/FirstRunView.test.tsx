import type { DraftRecord } from '@dispatch/client';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

test('an agent that cannot draft gets the two-field form, which creates the task', async () => {
  const onCreateTask = mock(() => Promise.resolve());
  render(
    <FirstRunView
      projectName="dispatch"
      planner={false}
      onCreateTask={onCreateTask}
      onStartDraft={() => Promise.resolve(draft)}
      onBrowseBoard={() => {}}
    />
  );
  expect(screen.queryByText('Draft task')).toBeNull();
  fireEvent.change(screen.getByLabelText('What should change?'), {
    target: { value: '  Add a dark mode toggle  ' },
  });
  fireEvent.change(screen.getByLabelText("How will you know it's done?"), {
    target: { value: 'The theme switches' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
  await waitFor(() =>
    expect(onCreateTask).toHaveBeenCalledWith({
      what: 'Add a dark mode toggle',
      done: 'The theme switches',
    })
  );
});

test('a double click on Create task creates one task', async () => {
  let finish = () => {};
  const onCreateTask = mock(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  render(
    <FirstRunView
      projectName="dispatch"
      planner={false}
      onCreateTask={onCreateTask}
      onStartDraft={() => Promise.resolve(draft)}
      onBrowseBoard={() => {}}
    />
  );
  fireEvent.change(screen.getByLabelText('What should change?'), {
    target: { value: 'Add a dark mode toggle' },
  });
  const create = screen.getByRole('button', { name: 'Create task' });
  // Both clicks land before React re-renders the button as disabled.
  act(() => {
    create.click();
    create.click();
  });
  expect(onCreateTask).toHaveBeenCalledTimes(1);
  await act(() => {
    finish();
    return Promise.resolve();
  });
  await waitFor(() =>
    expect(screen.getByLabelText('What should change?')).toHaveProperty(
      'value',
      ''
    )
  );
});

test('the form needs a change before it can create anything', () => {
  render(
    <FirstRunView
      projectName="dispatch"
      planner={false}
      onCreateTask={() => Promise.resolve()}
      onStartDraft={() => Promise.resolve(draft)}
      onBrowseBoard={() => {}}
    />
  );
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Create task' })
      .disabled
  ).toBe(true);
});

test('a draft that failed after the box emptied shows why', () => {
  const onRetry = mock(() => Promise.resolve());
  render(
    <FirstRunView
      projectName="dispatch"
      onStartDraft={() => Promise.resolve(draft)}
      onBrowseBoard={() => {}}
      failure={{ error: 'Not logged in', providerId: 'claude', onRetry }}
    />
  );
  expect(
    screen.getByText('Claude Code needs you to sign in again.')
  ).toBeTruthy();
  // A sign-in cause links to Setup (inside the shell); outside it, no Try again.
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});

test('a draft that failed for another reason can be retried', async () => {
  const onRetry = mock(() => Promise.resolve());
  render(
    <FirstRunView
      projectName="dispatch"
      onStartDraft={() => Promise.resolve(draft)}
      onBrowseBoard={() => {}}
      failure={{
        error: 'planner produced no task for this description',
        onRetry,
      }}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
});

test('the prompt grows with its text, its rows the minimum', () => {
  setup();
  const prompt = box() as HTMLTextAreaElement;
  expect(prompt.getAttribute('rows')).toBe('4');
  // happy-dom lays nothing out, so stand in the height the text would take.
  Object.defineProperty(prompt, 'scrollHeight', {
    configurable: true,
    value: 180,
  });
  fireEvent.input(prompt, { target: { value: 'one\ntwo\nthree\nfour\nfive' } });
  expect(prompt.style.height).toBe('180px');
});

test('drafting is said in words while the Spinner turns', async () => {
  let finish: (record: DraftRecord) => void = () => {};
  setup({
    onStartDraft: () =>
      new Promise<DraftRecord>((resolve) => {
        finish = resolve;
      }),
  });
  // Mounted empty before anything happens, so the words are announced.
  const status = screen.getByRole('status');
  expect(status.textContent).toBe('');
  fireEvent.change(box(), { target: { value: 'do the thing' } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  await waitFor(() => expect(status.textContent).toBe('Drafting your task…'));
  expect(screen.getByRole('button', { name: 'Drafting…' })).toHaveProperty(
    'disabled',
    true
  );
  await act(() => {
    finish(draft);
    return Promise.resolve();
  });
  await waitFor(() => expect(status.textContent).toBe(''));
});

test('the prompt keeps the 16px size phones need, from a token', () => {
  // bun loads a CSS module as an empty map, so this reads the sheet: under
  // 16px iOS zooms the page in on focus, and the library's own 16px rule for
  // touch screens loses to this two-class rule.
  const sheet = readFileSync(
    join(import.meta.dir, 'FirstRunView.module.css'),
    'utf8'
  );
  const rule = /\.column \.prompt \{([^}]*)\}/.exec(sheet)?.[1] ?? '';
  expect(rule).toContain('font-size: var(--fs-lg);');
});
