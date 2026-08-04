import { ApiError } from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { dataWith } from './fixtures.test-helper';
import { LinearPanel } from './LinearPanel';

// An env key can't be disconnected from here, so the row that offers to isn't shown at all —
// only the note explaining where the key came from, next to a still-open connect input. The
// rest of the sync settings (team picker etc.) must still render — this project is connected,
// just not on its own key.
test('an env-sourced key hides Disconnect, says where the key came from, and keeps sync settings', () => {
  render(
    <LinearPanel data={dataWith({ keySource: 'env', connected: true })} />
  );
  expect(screen.queryByRole('button', { name: /Disconnect/ })).toBeNull();
  expect(screen.getByText(/LINEAR_API_KEY/)).toBeDefined();
  expect(screen.getByPlaceholderText('Linear API key')).toBeDefined();
  expect(screen.getByRole('combobox', { name: 'Team' })).toBeDefined();
});

// The reported symptom: the picker opened with nothing in it and no reason.
test('a failed team fetch explains the empty picker and offers a retry', () => {
  render(
    <LinearPanel
      data={dataWith({
        keySource: 'project',
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
        keySource: 'project',
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

test('a project-sourced key leaves Disconnect enabled', () => {
  render(
    <LinearPanel data={dataWith({ keySource: 'project', connected: true })} />
  );
  const button: HTMLButtonElement = screen.getByRole('button', {
    name: /Disconnect/,
  });
  expect(button.disabled).toBe(false);
  expect(screen.queryByPlaceholderText('Linear API key')).toBeNull();
});

// The shared machine-wide key is a read-only fallback — there is no Disconnect for it, only
// the note inviting the user to give this project its own key instead.
test('a global-sourced key hides Disconnect and invites a project override', () => {
  render(
    <LinearPanel data={dataWith({ keySource: 'global', connected: true })} />
  );
  expect(screen.queryByRole('button', { name: /Disconnect/ })).toBeNull();
  expect(screen.getByText(/shared default key/)).toBeDefined();
});
