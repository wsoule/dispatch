import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

import {
  type ShellActions,
  ShellActionsProvider,
} from '../shell/ShellActionsContext';
import { askAgentToFix, FailureNotice } from './FailureNotice';

function withShell(ui: ReactNode) {
  const setGlobalView = mock(() => {});
  const shell = { setGlobalView } as unknown as ShellActions;
  render(<ShellActionsProvider value={shell}>{ui}</ShellActionsProvider>);
  return { setGlobalView };
}

test('a sign-in failure links to Settings → Setup and nothing else', async () => {
  const onRetry = mock(() => {});
  const { setGlobalView } = withShell(
    <FailureNotice error="Not logged in" providerId="codex" onRetry={onRetry} />
  );
  expect(screen.getByText('Codex needs you to sign in again.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: 'Fix in Settings → Setup' })
  );
  expect(setGlobalView).toHaveBeenCalledWith('settings', { page: 'setup' });
  // The raw text waits behind Details.
  expect(screen.queryByText('Not logged in')).toBeNull();
  fireEvent.click(screen.getByText('Details'));
  expect(await screen.findByText('Not logged in')).toBeTruthy();
});

test('any other failure offers Try again and Ask the agent to fix it', async () => {
  const onRetry = mock(() => Promise.resolve());
  const onAskAgent = mock(() => Promise.resolve());
  render(
    <FailureNotice
      error="git worktree add failed: fatal: could not create directory"
      onRetry={onRetry}
      onAskAgent={onAskAgent}
    />
  );
  expect(
    screen.getByText(
      "Dispatch couldn't make a working copy of your project for the agent."
    )
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
  fireEvent.click(
    screen.getByRole('button', { name: 'Ask the agent to fix it' })
  );
  await waitFor(() => expect(onAskAgent).toHaveBeenCalledTimes(1));
});

test('an unrecognised one-line failure is shown as is, with no Details', () => {
  render(<FailureNotice error="TypeError: x is undefined" />);
  expect(screen.getByText('TypeError: x is undefined')).toBeTruthy();
  expect(screen.queryByText('Details')).toBeNull();
});

test('outside the app shell a setup cause still explains itself', () => {
  render(<FailureNotice error="spawn gemini ENOENT" />);
  expect(
    screen.getByText("Gemini CLI isn't installed, or Dispatch can't find it.")
  ).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Fix in Settings → Setup' })
  ).toBeNull();
});

test('a fix that fails says why', async () => {
  render(
    <FailureNotice
      error="TypeError: boom"
      onRetry={() => Promise.reject(new Error('daemon unreachable'))}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('daemon unreachable')).toBeTruthy();
});

test('Ask the agent to fix it quotes the failure', () => {
  expect(askAgentToFix('npm ERR! missing script: test')).toContain(
    'npm ERR! missing script: test'
  );
});

test('it is one danger alert carrying the failure-notice hook', () => {
  render(<FailureNotice error="TypeError: x is undefined" />);
  const alert = screen.getByRole('alert');
  expect(alert.getAttribute('data-slot')).toBe('failure-notice');
  expect(alert.getAttribute('data-tone')).toBe('danger');
  expect(alert.textContent).toContain('TypeError: x is undefined');
});

test('the Details fold names the raw error it opens', () => {
  render(<FailureNotice error={'boom\nat line 2'} />);
  const details = screen.getByRole('button', { name: 'Details' });
  expect(details.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(details);
  expect(details.getAttribute('aria-expanded')).toBe('true');
  const panel = document.getElementById(
    details.getAttribute('aria-controls') ?? ''
  );
  expect(panel?.textContent).toContain('at line 2');
});
