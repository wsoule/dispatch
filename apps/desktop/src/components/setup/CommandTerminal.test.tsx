import type { ApiClient } from '@dispatch/client';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, mock, test } from 'bun:test';
import { Activity, type ReactNode, StrictMode } from 'react';

import { CommandTerminal } from './CommandTerminal';

const COMMAND = ['claude', 'auth', 'login'];
const TITLE = 'Sign in to Claude Code';

// A client whose terminal reports `state`; `start` is the createTerminal reply,
// which a test may hold back to unmount before the command has started.
function clientWith(
  state: 'running' | 'exited' = 'running',
  start: Promise<{ id: string; state: string; pty: boolean }> = Promise.resolve(
    { id: 't1', state: 'running', pty: true }
  )
) {
  const info = {
    id: 't1',
    state,
    pty: true,
    exitCode: state === 'exited' ? 0 : null,
  };
  return {
    createTerminal: mock((_input: unknown) => start),
    fetchTerminal: mock(() => Promise.resolve(info)),
    fetchTerminalOutput: mock(() =>
      Promise.resolve({
        data: '',
        next: 0,
        more: false,
        state,
        exitCode: info.exitCode,
        total: 0,
      })
    ),
    sendTerminalInput: mock((_id: string, _data: string) => Promise.resolve()),
    closeTerminal: mock((_id: string) => Promise.resolve()),
  };
}

type Client = ReturnType<typeof clientWith>;

// A sign-in by default (it ends with its terminal); `endOnUnmount: false` is
// an installer, which runs to its end.
function terminal(
  client: Client,
  onExit: (code: number | null) => void = () => {},
  endOnUnmount = true
) {
  return (
    <CommandTerminal
      client={client as unknown as ApiClient}
      command={COMMAND}
      title={TITLE}
      onExit={onExit}
      endOnUnmount={endOnUnmount}
    />
  );
}

// Lets the start, the first output read and the effects they schedule land.
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  await settle();
  cleanup();
});

test('the surface is a focused textbox named by its title, as the Terminals pane is', async () => {
  const client = clientWith();
  render(terminal(client));
  await settle();
  const surface = screen.getByRole('textbox', { name: TITLE });
  expect(surface.getAttribute('tabindex')).toBe('0');
  expect(document.activeElement).toBe(surface);
  expect(client.createTerminal).toHaveBeenCalledWith({
    command: COMMAND,
    title: TITLE,
  });
});

test('unmounting while the command runs ends it', async () => {
  const client = clientWith();
  const { unmount } = render(terminal(client));
  await settle();
  expect(client.closeTerminal).not.toHaveBeenCalled();
  unmount();
  expect(client.closeTerminal).toHaveBeenCalledTimes(1);
  expect(client.closeTerminal).toHaveBeenCalledWith('t1');
});

test('a command that already exited is not ended again on unmount', async () => {
  const client = clientWith('exited');
  const exits: (number | null)[] = [];
  const { unmount } = render(terminal(client, (code) => exits.push(code)));
  await settle();
  await settle();
  expect(exits).toEqual([0]);
  unmount();
  expect(client.closeTerminal).not.toHaveBeenCalled();
});

test('a start that lands after the unmount is ended at once', async () => {
  let started: (value: {
    id: string;
    state: string;
    pty: boolean;
  }) => void = () => {};
  const client = clientWith(
    'running',
    new Promise((resolve) => {
      started = resolve;
    })
  );
  const { unmount } = render(terminal(client));
  unmount();
  expect(client.closeTerminal).not.toHaveBeenCalled();
  await act(async () => {
    started({ id: 't1', state: 'running', pty: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(client.closeTerminal).toHaveBeenCalledWith('t1');
});

test('StrictMode starts the command once and ends nothing until the real unmount', async () => {
  const client = clientWith();
  const { unmount } = render(<StrictMode>{terminal(client)}</StrictMode>);
  await settle();
  expect(client.createTerminal).toHaveBeenCalledTimes(1);
  expect(client.closeTerminal).not.toHaveBeenCalled();
  unmount();
  expect(client.closeTerminal).toHaveBeenCalledTimes(1);
});

test('a hidden Activity keeps the command running, and shows the same terminal again', async () => {
  const client = clientWith();
  const host = (mode: 'visible' | 'hidden'): ReactNode => (
    <Activity mode={mode}>{terminal(client)}</Activity>
  );
  const { rerender, unmount } = render(host('visible'));
  await settle();
  rerender(host('hidden'));
  await settle();
  expect(client.closeTerminal).not.toHaveBeenCalled();
  rerender(host('visible'));
  await settle();
  expect(client.closeTerminal).not.toHaveBeenCalled();
  expect(client.createTerminal).toHaveBeenCalledTimes(1);
  unmount();
  expect(client.closeTerminal).toHaveBeenCalledTimes(1);
});

test('an installer is left to finish when its terminal unmounts', async () => {
  const client = clientWith();
  const { unmount } = render(terminal(client, () => {}, false));
  await settle();
  unmount();
  await settle();
  expect(client.closeTerminal).not.toHaveBeenCalled();
});

test('a terminal removed while a hidden Activity holds it ends its command then', async () => {
  const client = clientWith();
  const host = (mode: 'visible' | 'hidden', shown: boolean): ReactNode => (
    <Activity mode={mode}>{shown ? terminal(client) : null}</Activity>
  );
  const { rerender } = render(host('visible', true));
  await settle();
  rerender(host('hidden', true));
  await settle();
  expect(client.closeTerminal).not.toHaveBeenCalled();
  // The gate clears while Settings covers it: no cleanup runs for a hidden
  // subtree, so the removal itself must end the command.
  rerender(host('hidden', false));
  await settle();
  expect(client.closeTerminal).toHaveBeenCalledTimes(1);
  expect(client.closeTerminal).toHaveBeenCalledWith('t1');
});

test('a hidden terminal shown again stops watching, and ends only on its real unmount', async () => {
  const client = clientWith();
  const host = (mode: 'visible' | 'hidden'): ReactNode => (
    <Activity mode={mode}>{terminal(client)}</Activity>
  );
  const { rerender, unmount } = render(host('visible'));
  await settle();
  rerender(host('hidden'));
  await settle();
  rerender(host('visible'));
  await settle();
  unmount();
  await settle();
  // Once, from the unmount; the hide's watch did not fire a second time.
  expect(client.closeTerminal).toHaveBeenCalledTimes(1);
});

test('Tab and Shift+Tab move focus on: nothing is sent and the key is not taken', async () => {
  const client = clientWith();
  render(terminal(client));
  await settle();
  const surface = screen.getByRole('textbox', { name: TITLE });
  for (const shiftKey of [false, true]) {
    const allowed = fireEvent.keyDown(surface, { key: 'Tab', shiftKey });
    expect(allowed).toBe(true);
  }
  // Another key still reaches the command, so the surface is live.
  const sent = fireEvent.keyDown(surface, { key: 'Enter' });
  expect(sent).toBe(false);
  await settle();
  expect(client.sendTerminalInput.mock.calls).toEqual([['t1', '\r']]);
});
