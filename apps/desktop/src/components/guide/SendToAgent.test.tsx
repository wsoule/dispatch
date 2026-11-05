import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { parseWrites, SendToAgent } from './SendToAgent';

test('one click sends on the defaults', async () => {
  const onSend = mock(() => Promise.resolve());
  render(<SendToAgent options={{ modelChoice: true }} onSend={onSend} />);
  fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
  await waitFor(() => expect(onSend).toHaveBeenCalledWith({ writes: [] }));
});

test('More options carries the model, effort and files it may change', async () => {
  const onSend = mock(() => Promise.resolve());
  render(
    <SendToAgent
      options={{ modelChoice: true, defaultModel: 'claude-opus-5-5' }}
      onSend={onSend}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'More options' }));
  // The popover's fields mount on the click that opens it.
  fireEvent.change(screen.getByLabelText('Model'), {
    target: { value: 'claude-sonnet-5-5' },
  });
  fireEvent.change(screen.getByLabelText('Effort'), {
    target: { value: 'high' },
  });
  fireEvent.change(screen.getByLabelText('Files it may change'), {
    target: { value: ' src/a.ts \n\n src/b/** ' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
  await waitFor(() =>
    expect(onSend).toHaveBeenCalledWith({
      model: 'claude-sonnet-5-5',
      effort: 'high',
      writes: ['src/a.ts', 'src/b/**'],
    })
  );
});

test("another agent gets no model or effort picker (they are Claude's lists)", () => {
  render(
    <SendToAgent
      options={{ modelChoice: false }}
      onSend={() => Promise.resolve()}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'More options' }));
  expect(screen.getByLabelText('Files it may change')).toBeTruthy();
  expect(screen.queryByLabelText('Model')).toBeNull();
  expect(screen.queryByLabelText('Effort')).toBeNull();
});

test('Escape closes More options and hands focus back to its button', () => {
  render(
    <SendToAgent
      options={{ modelChoice: true }}
      onSend={() => Promise.resolve()}
    />
  );
  const trigger = screen.getByRole('button', { name: 'More options' });
  fireEvent.click(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  const popover = screen.getByRole('dialog', { name: 'More options' });
  // Focus lands on the first field inside on open.
  expect(popover.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(screen.getByLabelText('Effort'), { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'More options' })).toBeNull();
  expect(screen.queryByLabelText('Files it may change')).toBeNull();
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
});

test('a refused send explains itself', async () => {
  render(
    <SendToAgent
      options={{ modelChoice: false }}
      onSend={() =>
        Promise.reject(new Error('Claude Code CLI not found. Install it'))
      }
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
  expect(
    await screen.findByText(
      "Claude Code isn't installed, or Dispatch can't find it."
    )
  ).toBeTruthy();
});

test('declared files are one per line, trimmed', () => {
  expect(parseWrites(' a\n\n  b/** \n')).toEqual(['a', 'b/**']);
});

test('two quick clicks send once', () => {
  const onSend = mock(() => new Promise<void>(() => {}));
  render(<SendToAgent options={{ modelChoice: false }} onSend={onSend} />);
  const button = screen.getByRole('button', { name: 'Send to agent' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(onSend).toHaveBeenCalledTimes(1);
});

test('sending is said in words while the Spinner turns', async () => {
  let finish = () => {};
  const onSend = mock(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  render(<SendToAgent options={{ modelChoice: false }} onSend={onSend} />);
  // Mounted empty before the click, so the words are announced.
  const status = screen.getByRole('status');
  expect(status.textContent).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
  await waitFor(() => expect(status.textContent).toBe('Sending to the agent…'));
  finish();
  await waitFor(() => expect(status.textContent).toBe(''));
});
