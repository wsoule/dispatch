import type { TerminalInfo } from '@dispatch/client';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { TerminalsView } from './TerminalsView';

function terminal(id: string): TerminalInfo {
  return {
    id,
    title: `zsh ${id}`,
    cwd: '/repo',
    command: ['zsh'],
    cols: 120,
    rows: 32,
    startedAt: '2026-11-03T00:00:00Z',
    exitedAt: null,
    exitCode: null,
    state: 'running',
    pty: true,
    total: 0,
    trimmed: 0,
    runId: null,
  };
}

// Only what TerminalsView and an attached pane read; creates are recorded.
function fakeData(created: unknown[]): DispatchProjectData {
  return {
    client: {
      fetchTerminals: () => Promise.resolve([]),
      connectEvents: () => () => {},
      createTerminal: (input: unknown) => {
        created.push(input);
        return Promise.resolve(terminal('t-1'));
      },
      fetchTerminal: () => Promise.resolve(terminal('t-1')),
      fetchTerminalOutput: () =>
        Promise.resolve({
          id: 't-1',
          data: '',
          next: 0,
          more: false,
          state: 'running',
          exitCode: null,
          total: 0,
        }),
    },
    portLoading: false,
    portErrorDetail: null,
    retryEnsureDispatchd: () => {},
  } as unknown as DispatchProjectData;
}

test('heads the page with the title and the receipts', async () => {
  render(<TerminalsView data={fakeData([])} />);
  expect(
    screen.getByRole('heading', { level: 1, name: 'Terminals' })
  ).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByText('0 sessions · 1 pane')).toBeTruthy()
  );
});

test('hosted in a run page, the title steps down to an h2', async () => {
  render(<TerminalsView data={fakeData([])} runId="run-1" />);
  expect(
    screen.getByRole('heading', { level: 2, name: 'Terminals' })
  ).toBeTruthy();
  expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  // Let the session list settle so its update lands inside the test.
  await waitFor(() =>
    expect(screen.getByText('0 sessions · 1 pane')).toBeTruthy()
  );
});

test('New session opens a shell and attaches it to the pane', async () => {
  const created: unknown[] = [];
  render(<TerminalsView data={fakeData(created)} runId="run-1" />);
  // The pane's toolbar has an icon button of the same name; this is the head's.
  const head = screen.getByRole('banner');
  fireEvent.click(within(head).getByRole('button', { name: 'New session' }));
  await waitFor(() => expect(created).toEqual([{ runId: 'run-1' }]));
  await waitFor(() =>
    expect(screen.getByText('1 session · 1 pane')).toBeTruthy()
  );
  // The pane now shows the canvas instead of the empty prompt.
  await waitFor(() =>
    expect(screen.getByTestId('terminal-canvas')).toBeTruthy()
  );
  expect(screen.queryByText('No session in this pane.')).toBeNull();
});

test('without a client it shows the daemon notice', () => {
  const data = { ...fakeData([]), client: null } as DispatchProjectData;
  render(<TerminalsView data={data} />);
  expect(screen.queryByRole('heading', { name: 'Terminals' })).toBeNull();
});
