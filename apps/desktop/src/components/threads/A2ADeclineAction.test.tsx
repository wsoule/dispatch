import type { Message } from '@dispatch/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { A2ADeclineAction } from './A2ADeclineAction';

function q(over: Partial<Message> = {}): Message {
  return {
    id: 'm-1',
    thread: 'm-1',
    replyTo: null,
    from: 'agent:wyat/a2a.acme',
    to: ['human:wyat'],
    kind: 'question',
    body: 'Is /sessions final?',
    refs: [],
    urgent: false,
    blocking: true,
    wake: 'none',
    createdAt: '2026-09-25T10:00:00.000Z',
    ...over,
  };
}
const clientWith = (
  declineA2ATask: (id: string, reason?: string) => Promise<unknown>
) => ({ declineA2ATask }) as never;

test('declines a question from an A2A client with the reason typed', async () => {
  const declineA2ATask = mock((_id: string, _reason?: string) =>
    Promise.resolve({})
  );
  render(
    <A2ADeclineAction
      message={q()}
      client={clientWith(declineA2ATask)}
      canDecide
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
  expect(document.activeElement).toBe(screen.getByLabelText('Reason'));
  fireEvent.change(screen.getByLabelText('Reason'), {
    target: { value: 'out of scope' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Decline question' }));
  await waitFor(() =>
    expect(declineA2ATask).toHaveBeenCalledWith('m-1', 'out of scope')
  );
});

test('sends no reason when the field is left empty', async () => {
  const declineA2ATask = mock((_id: string, _reason?: string) =>
    Promise.resolve({})
  );
  render(
    <A2ADeclineAction
      message={q()}
      client={clientWith(declineA2ATask)}
      canDecide
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
  fireEvent.click(screen.getByRole('button', { name: 'Decline question' }));
  await waitFor(() =>
    expect(declineA2ATask).toHaveBeenCalledWith('m-1', undefined)
  );
});

test('says why a decline was refused, and keeps the reason', async () => {
  render(
    <A2ADeclineAction
      message={q()}
      client={clientWith(() =>
        Promise.reject(new Error('this question was just answered'))
      )}
      canDecide
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
  fireEvent.change(screen.getByLabelText('Reason'), {
    target: { value: 'not now' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Decline question' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'this question was just answered'
  );
  expect(screen.getByLabelText<HTMLInputElement>('Reason').value).toBe(
    'not now'
  );
});

test('cancel puts the Decline button back without declining', () => {
  const declineA2ATask = mock((_id: string, _reason?: string) =>
    Promise.resolve({})
  );
  render(
    <A2ADeclineAction
      message={q()}
      client={clientWith(declineA2ATask)}
      canDecide
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy();
  expect(declineA2ATask).not.toHaveBeenCalled();
});

test('renders nothing for a run’s question or for a viewer who cannot decide', () => {
  const fromRun = render(
    <A2ADeclineAction
      message={q({ from: 'run:r-000001' })}
      client={clientWith(mock(() => Promise.resolve({})))}
      canDecide
    />
  );
  expect(fromRun.container.innerHTML).toBe('');
  const below = render(
    <A2ADeclineAction
      message={q()}
      client={clientWith(mock(() => Promise.resolve({})))}
      canDecide={false}
    />
  );
  expect(below.container.innerHTML).toBe('');
});
