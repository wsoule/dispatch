import { act, fireEvent, render, screen } from '@testing-library/react';
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

import { taskToastDescription, viewTaskLink } from './toastContract';
import { type ToastInput, ToastProvider, useToasts } from './Toasts';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// The latest push, handed out of the tree by an effect.
const holder: { api: ReturnType<typeof useToasts> | null } = { api: null };

function Capture() {
  const api = useToasts();
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

function push(input: ToastInput) {
  act(() => {
    holder.api?.push(input);
  });
}

/** The one toast on screen (the library's `<li data-kind>`), with its sentence and its direct
 * `<span>` children: the icon, plus the countdown line while the toast is timed. */
function toast(): { item: HTMLElement; text: string; spans: number } {
  const item = screen
    .getByRole('region', { name: 'Notifications' })
    .querySelector('li');
  if (item === null) throw new Error('no toast on screen');
  return {
    item,
    text: item.querySelector('p')?.textContent ?? '',
    spans: Array.from(item.children).filter((el) => el.tagName === 'SPAN')
      .length,
  };
}

function stackText(): string {
  return (
    screen.queryByRole('region', { name: 'Notifications' })?.textContent ?? ''
  );
}

describe('ToastProvider over @dispatch/ui', () => {
  test('a title-only success reads as just the title and leaves after 3.5s', () => {
    setup();
    push({ title: 'Copied t-8f2a', tone: 'success' });
    const { item, text, spans } = toast();
    expect(item.getAttribute('data-kind')).toBe('success');
    expect(text).toBe('Copied t-8f2a');
    // No lead-in span: the title is the whole sentence.
    expect(item.querySelector('p span')).toBeNull();
    expect(item.style.getPropertyValue('--toast-duration')).toBe('3500ms');
    expect(spans).toBe(2);
    // Screen readers still hear the kind.
    expect(screen.getByRole('status').textContent).toBe('Done: Copied t-8f2a');
    act(() => {
      jest.advanceTimersByTime(3400);
    });
    expect(stackText()).toContain('Copied t-8f2a');
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(stackText()).toBe('');
  });

  test('a described info toast reads the title as the lead-in and stays 4.5s', () => {
    setup();
    const onClick = mock(() => undefined);
    push({
      title: 'Dispatch 1.2.0 available',
      description: 'Restart to update.',
      action: { label: 'Restart', onClick },
    });
    const { item, text } = toast();
    expect(item.getAttribute('data-kind')).toBe('info');
    expect(text).toBe('Dispatch 1.2.0 available Restart to update.');
    expect(item.querySelector('p span')?.textContent).toBe(
      'Dispatch 1.2.0 available'
    );
    expect(item.style.getPropertyValue('--toast-duration')).toBe('4500ms');
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(stackText()).toBe('');
  });

  test('an error has no countdown and stays until dismissed', () => {
    setup();
    push({
      title: 'Save failed',
      description: 'Linear rejected the change.',
      tone: 'error',
    });
    const { item, text, spans } = toast();
    expect(item.getAttribute('data-kind')).toBe('error');
    expect(text).toBe('Save failed Linear rejected the change.');
    expect(item.style.getPropertyValue('--toast-duration')).toBe('');
    // The icon only: no timer line.
    expect(spans).toBe(1);
    expect(screen.getByRole('alert').textContent).toBe(
      'Save failed: Linear rejected the change.'
    );
    act(() => {
      jest.advanceTimersByTime(600_000);
    });
    expect(stackText()).toContain('Save failed');
    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss notification' })
    );
    expect(stackText()).toBe('');
  });

  test('a link is the action, and wins over an action', () => {
    setup();
    const opened: string[] = [];
    push({
      title: 'Task created',
      tone: 'success',
      description: taskToastDescription('t-8f2a', 'Cache the search index'),
      link: viewTaskLink('t-8f2a', (id) => opened.push(id)),
      action: { label: 'Restart', onClick: () => undefined },
    });
    expect(toast().text).toBe('Task created t-8f2a — Cache the search index');
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View task' }));
    expect(opened).toEqual(['t-8f2a']);
    expect(stackText()).toBe('');
  });

  test('useToasts throws outside the provider', () => {
    function Lone() {
      useToasts();
      return null;
    }
    expect(() => render(<Lone />)).toThrow(
      'useToasts must be used inside <ToastProvider>'
    );
  });
});
