import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';

import { ErrorBoundary } from './ErrorBoundary';

// React and the boundary both log a caught render error; keep the test output quiet.
let restoreConsole = (): void => {};
beforeEach(() => {
  const spy = spyOn(console, 'error').mockImplementation(() => {});
  restoreConsole = () => spy.mockRestore();
});
afterEach(() => {
  restoreConsole();
});

// A child that throws `message` while `shouldThrow()` says so, and otherwise renders a
// marker that also counts its mounts (to prove "Try again" remounts rather than resumes).
function makeChild(message: string) {
  const state = { shouldThrow: true, mounts: 0 };
  function Child() {
    if (state.shouldThrow) throw new Error(message);
    return <p ref={(node) => void (node && state.mounts++)}>Recovered view</p>;
  }
  return { Child, state };
}

test('a throwing child shows the fallback with the label and the message behind Details', () => {
  const { Child } = makeChild('Cannot read properties of undefined');
  render(
    <ErrorBoundary label="the diff">
      <Child />
    </ErrorBoundary>
  );
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain(
    'Something went wrong rendering the diff'
  );
  expect(alert.querySelector('[data-tone="danger"] svg')).not.toBeNull();
  expect(screen.queryByRole('button', { name: 'Reload app' })).toBeNull();
  expect(console.error).toHaveBeenCalled();

  const details = screen.getByRole('button', { name: 'Details' });
  expect(details.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(details);
  expect(details.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('Cannot read properties of undefined').tagName).toBe(
    'PRE'
  );
});

test('the label defaults to "this view"', () => {
  const { Child } = makeChild('boom');
  render(
    <ErrorBoundary>
      <Child />
    </ErrorBoundary>
  );
  expect(screen.getByRole('alert').textContent).toContain(
    'Something went wrong rendering this view'
  );
});

test('Try again remounts the children', () => {
  const { Child, state } = makeChild('boom');
  render(
    <ErrorBoundary>
      <Child />
    </ErrorBoundary>
  );
  expect(screen.queryByText('Recovered view')).toBeNull();
  state.shouldThrow = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.getByText('Recovered view')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(state.mounts).toBe(1);
});

test('a stale chunk error offers Reload app with the stale-module hint', () => {
  const { Child } = makeChild(
    'Failed to fetch dynamically imported module: http://x/assets/a.js'
  );
  const reload = mock(() => {});
  const original = window.location.reload;
  Object.defineProperty(window.location, 'reload', {
    configurable: true,
    value: reload,
  });
  try {
    render(
      <ErrorBoundary label="this task">
        <Child />
      </ErrorBoundary>
    );
    expect(
      screen.getByText(/A stale module was requested/).textContent
    ).toContain('reloading usually fixes this');
    fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    Object.defineProperty(window.location, 'reload', {
      configurable: true,
      value: original,
    });
  }
});
