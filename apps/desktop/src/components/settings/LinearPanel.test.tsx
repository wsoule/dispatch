import { ApiError } from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { dataWith } from './fixtures.test-helper';
import { LinearPanel } from './LinearPanel';

test('an env-sourced key disables Disconnect and says why', () => {
  render(
    <LinearPanel data={dataWith({ keySource: 'env', connected: true })} />
  );
  const button: HTMLButtonElement = screen.getByRole('button', {
    name: /Disconnect/,
  });
  expect(button.disabled).toBe(true);
  expect(screen.getByText(/LINEAR_API_KEY/)).toBeDefined();
});

// The reported symptom: the picker opened with nothing in it and no reason.
test('a failed team fetch explains the empty picker and offers a retry', () => {
  render(
    <LinearPanel
      data={dataWith({
        keySource: 'file',
        connected: true,
        linearTeams: [],
        linearTeamsError: new ApiError('Unauthorized', 401),
      })}
    />
  );
  expect(screen.getByText(/rejected this key/)).toBeDefined();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
});

// Pins the button to actual behaviour, not just its presence — a deleted
// onClick would still pass a "the button exists" assertion.
test('clicking Retry on a failed team fetch calls refetchLinearTeams', () => {
  let calls = 0;
  render(
    <LinearPanel
      data={dataWith({
        keySource: 'file',
        connected: true,
        linearTeams: [],
        linearTeamsError: new ApiError('Unauthorized', 401),
        refetchLinearTeams: () => {
          calls += 1;
        },
      })}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(calls).toBe(1);
});

test('a file-sourced key leaves Disconnect enabled', () => {
  render(
    <LinearPanel data={dataWith({ keySource: 'file', connected: true })} />
  );
  const button: HTMLButtonElement = screen.getByRole('button', {
    name: /Disconnect/,
  });
  expect(button.disabled).toBe(false);
});
