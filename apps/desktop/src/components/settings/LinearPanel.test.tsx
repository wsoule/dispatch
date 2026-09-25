import { ApiError } from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { accessFor, SettingsAccessProvider } from './access';
import { dataWith } from './fixtures.test-helper';
import { LinearPanel } from './LinearPanel';

// Whether a locked settings group has disabled this control. happy-dom does
// not carry a disabled fieldset down to its controls, so read the fieldset.
function lockedByGroup(element: HTMLElement): boolean {
  return element.closest('fieldset')?.disabled === true;
}

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

// The key decides whose Linear account the board goes to, so setting or
// removing it is the owner's; importing and syncing only use it.
test('below the operator tier, the key cannot change but import and sync still run', () => {
  const { unmount } = render(
    <SettingsAccessProvider access={accessFor('decide', false)}>
      <LinearPanel data={dataWith({ keySource: 'env', connected: true })} />
    </SettingsAccessProvider>
  );
  expect(
    screen.getByPlaceholderText<HTMLInputElement>('Linear API key').disabled
  ).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Connect' }).disabled
  ).toBe(true);
  // No team is chosen in this fixture, so these are disabled for that reason;
  // what matters here is that no tier lock reaches them.
  expect(
    lockedByGroup(screen.getByRole('button', { name: 'Import from Linear' }))
  ).toBe(false);
  expect(lockedByGroup(screen.getByRole('button', { name: /Sync now/ }))).toBe(
    false
  );
  unmount();

  render(
    <SettingsAccessProvider access={accessFor('decide', false)}>
      <LinearPanel data={dataWith({ keySource: 'project', connected: true })} />
    </SettingsAccessProvider>
  );
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: /Disconnect/ })
      .disabled
  ).toBe(true);
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

// Sync is a row whose title labels a `Switch`; the API-key field is the 13px book-weight
// `Input` with no code face, and the poll interval is sans with tabular digits.
test('sync is a switch and the key and interval inputs are sans', () => {
  render(
    <LinearPanel data={dataWith({ keySource: 'env', connected: true })} />
  );
  expect(
    screen.getByRole('switch', { name: 'Sync this project with Linear' })
  ).toBeDefined();
  const key = screen.getByPlaceholderText('Linear API key');
  expect(key.className).toContain('text-[13px]');
  expect(key.className).toContain('font-book');
  expect(key.className).not.toContain('font-mono');
  const interval = screen.getByLabelText('Poll interval');
  expect(interval.className).toContain('tabular-nums');
  expect(interval.className).not.toContain('font-mono');
});

// Connecting, importing and syncing are Linear's own routes, open to any
// teammate; the sync settings are config, which needs Can approve.
test('below the decide tier, connect and sync stay usable and the sync settings lock', () => {
  render(
    <SettingsAccessProvider access={accessFor('request', false)}>
      <LinearPanel data={dataWith({ keySource: 'env', connected: true })} />
    </SettingsAccessProvider>
  );
  expect(lockedByGroup(screen.getByPlaceholderText('Linear API key'))).toBe(
    false
  );
  expect(
    lockedByGroup(screen.getByRole('button', { name: 'Import from Linear' }))
  ).toBe(false);
  expect(lockedByGroup(screen.getByRole('button', { name: /Sync now/ }))).toBe(
    false
  );
  expect(
    lockedByGroup(
      screen.getByRole('switch', { name: 'Sync this project with Linear' })
    )
  ).toBe(true);
  expect(lockedByGroup(screen.getByRole('combobox', { name: 'Team' }))).toBe(
    true
  );
  expect(lockedByGroup(screen.getByLabelText('Poll interval'))).toBe(true);
});
