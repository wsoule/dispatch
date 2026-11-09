import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import type { PairRemoteInput } from '../../lib/remoteConnections';
import { ConnectRemoteForm } from './ConnectRemoteForm';

test('a pasted pairing link fills the URL and the code', async () => {
  const pair = mock((_input: PairRemoteInput) =>
    Promise.resolve('dispatch-remote://d-1')
  );
  const onConnected = mock((_root: string) => {});
  render(<ConnectRemoteForm onConnected={onConnected} pair={pair} />);
  fireEvent.change(screen.getByLabelText('Daemon URL or pairing link'), {
    target: {
      value: 'dispatch://pair?url=https%3A%2F%2Fdevbox%3A4771&code=ABCD-EFGH',
    },
  });
  expect(screen.queryByLabelText('Pairing code')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await waitFor(() =>
    expect(onConnected).toHaveBeenCalledWith('dispatch-remote://d-1')
  );
  expect(pair.mock.calls[0]?.[0]).toMatchObject({
    url: 'https://devbox:4771',
    code: 'ABCD-EFGH',
  });
});

test('plain http to another machine is refused before connecting', () => {
  const pair = mock(() => Promise.resolve('dispatch-remote://d-1'));
  render(<ConnectRemoteForm onConnected={() => {}} pair={pair} />);
  fireEvent.change(screen.getByLabelText('Daemon URL or pairing link'), {
    target: { value: 'http://192.168.1.20:4771' },
  });
  fireEvent.change(screen.getByLabelText('Pairing code'), {
    target: { value: 'ABCD-EFGH' },
  });
  expect(screen.getByText(/must be https/)).toBeDefined();
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Connect' }).disabled
  ).toBe(true);
});

test('a refused code shows the daemon’s reason', async () => {
  const pair = mock(() =>
    Promise.reject(new Error('pairing code not recognized'))
  );
  render(<ConnectRemoteForm onConnected={() => {}} pair={pair} />);
  fireEvent.change(screen.getByLabelText('Daemon URL or pairing link'), {
    target: { value: 'http://127.0.0.1:4800' },
  });
  fireEvent.change(screen.getByLabelText('Pairing code'), {
    target: { value: 'ZZZZ-ZZZZ' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'not recognized'
  );
});
