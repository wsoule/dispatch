import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from 'bun:test';
import { useEffect } from 'react';

import { ToastProvider, useToast } from '../src/shell/toast';
import type { ToastApi, ToastInput } from '../src/shell/types';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

// The latest toast API, handed out of the tree by an effect.
const holder: { api: ToastApi | null } = { api: null };

function Capture() {
  const api = useToast();
  useEffect(() => {
    holder.api = api;
  }, [api]);
  return null;
}

function setup() {
  render(
    <ToastProvider>
      <Capture />
    </ToastProvider>
  );
}

function show(input: ToastInput): string {
  let id = '';
  act(() => {
    id = holder.api?.toast(input) ?? '';
  });
  return id;
}

function stack(): HTMLElement {
  return screen.getByRole('region', { name: 'Notifications' });
}

/** The stack's text; '' once the last toast is gone (the region is then
    unnamed, so it is no longer a landmark). */
function stackText(): string {
  return (
    screen.queryByRole('region', { name: 'Notifications' })?.textContent ?? ''
  );
}

describe('toasts', () => {
  test('an info toast is announced politely and dismisses after 4s', () => {
    setup();
    show({
      kind: 'info',
      label: 'Saved',
      message: 'Target date moved to Oct 24.',
    });
    expect(stackText()).toContain('Target date moved to Oct 24.');
    const polite = screen.getByRole('status');
    expect(polite.getAttribute('aria-live')).toBe('polite');
    expect(polite.textContent).toContain('Target date moved to Oct 24.');
    act(() => {
      jest.advanceTimersByTime(3990);
    });
    expect(stackText()).toContain('Target date moved');
    act(() => {
      jest.advanceTimersByTime(20);
    });
    expect(stackText()).not.toContain('Target date moved');
  });

  test('an error toast is announced assertively', () => {
    setup();
    show({ kind: 'error', message: 'Linear rejected the change.' });
    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('aria-live')).toBe('assertive');
    expect(alert.textContent).toContain('Linear rejected the change.');
    expect(screen.getByRole('status').textContent).toBe('');
  });

  test('hover and focus pause the countdown', () => {
    setup();
    show({ kind: 'info', message: 'Copied the link.' });
    const item = stack().querySelector('li');
    expect(item).not.toBeNull();
    if (item === null) return;
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    fireEvent.mouseEnter(item);
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(stackText()).toContain('Copied the link.');
    fireEvent.mouseLeave(item);
    act(() => {
      jest.advanceTimersByTime(900);
    });
    expect(stackText()).toContain('Copied the link.');
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(stackText()).not.toContain('Copied the link.');

    show({ kind: 'info', message: 'Focus keeps me.' });
    const dismiss = screen.getByRole('button', {
      name: 'Dismiss notification',
    });
    act(() => {
      dismiss.focus();
    });
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(stackText()).toContain('Focus keeps me.');
  });

  test('keeps at most three on screen, newest last', () => {
    setup();
    for (const n of [1, 2, 3, 4]) show({ kind: 'info', message: `Toast ${n}` });
    const items = stack().querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('Toast 2');
    expect(items[2].textContent).toContain('Toast 4');
  });

  test('the action runs and dismisses the toast', () => {
    setup();
    const onClick = mock(() => undefined);
    show({
      kind: 'error',
      message: 'Could not save the date.',
      action: { label: 'Retry', onClick },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(stackText()).not.toContain('Could not save the date.');
  });

  test('the stack is a landmark only while it holds toasts', () => {
    setup();
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull();
    show({ kind: 'info', message: 'Copied.' });
    expect(stack()).toBeTruthy();
    act(() => {
      jest.advanceTimersByTime(4100);
    });
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull();
  });

  test('closing a focused toast hands focus on, never to <body>', () => {
    render(
      <ToastProvider>
        <Capture />
        <button type="button">Save date</button>
      </ToastProvider>
    );
    const save = screen.getByRole('button', { name: 'Save date' });
    act(() => {
      save.focus();
    });
    show({
      kind: 'info',
      message: 'Saved.',
      action: { label: 'Undo', onClick: () => undefined },
    });
    show({ kind: 'error', message: 'Linear did not answer.' });
    const undo = screen.getByRole('button', { name: 'Undo' });
    // Tabbing in: the browser reports where focus came from.
    act(() => {
      undo.focus();
    });
    fireEvent.focus(undo, { relatedTarget: save });

    // The focused toast's action closes it: focus moves to the next toast.
    fireEvent.click(undo);
    expect(stackText()).not.toContain('Saved.');
    const next = document.activeElement;
    expect(next?.getAttribute('aria-label')).toBe('Dismiss notification');
    expect(stack().contains(next)).toBe(true);

    // The last toast closes: focus goes back to where the user was.
    if (next instanceof HTMLElement) fireEvent.click(next);
    expect(stackText()).toBe('');
    expect(document.activeElement).toBe(save);
  });

  test('a neighbour timing out does not move focus', () => {
    setup();
    show({ kind: 'info', message: 'Stays: focused.' });
    show({ kind: 'info', message: 'Goes: times out.' });
    const [first] = screen.getAllByRole('button', {
      name: 'Dismiss notification',
    });
    act(() => {
      first.focus();
    });
    act(() => {
      jest.advanceTimersByTime(4100);
    });
    expect(stackText()).not.toContain('Goes: times out.');
    expect(stackText()).toContain('Stays: focused.');
    expect(document.activeElement).toBe(first);
  });
});

describe('toasts: spoken text and close callbacks', () => {
  test('announce replaces the sentence in the live region only', () => {
    setup();
    show({
      kind: 'info',
      label: 'Saved',
      message: 'Moved ENG-11 to Atlas billing migration › Read path switch.',
      announce:
        'Moved ENG-11 to Atlas billing migration, Read path switch. Press Z to undo.',
    });
    expect(stackText()).toContain(
      'Atlas billing migration › Read path switch.'
    );
    expect(stackText()).not.toContain('Press Z');
    expect(screen.getByRole('status').textContent).toBe(
      'Saved: Moved ENG-11 to Atlas billing migration, Read path switch. Press Z to undo.'
    );
  });

  test('onClose runs once when the toast leaves, however it goes', () => {
    setup();
    const timedOut = mock(() => undefined);
    const dismissed = mock(() => undefined);
    show({ kind: 'info', message: 'One.', duration: 1000, onClose: timedOut });
    const id = show({ kind: 'info', message: 'Two.', onClose: dismissed });
    expect(timedOut).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1100);
    });
    expect(timedOut).toHaveBeenCalledTimes(1);
    act(() => holder.api?.dismiss(id));
    expect(dismissed).toHaveBeenCalledTimes(1);
    expect(timedOut).toHaveBeenCalledTimes(1);
  });
});
