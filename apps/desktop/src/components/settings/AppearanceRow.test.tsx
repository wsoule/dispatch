import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';

import { THEME_STORAGE_KEY } from '../../lib/theme';
import { accessFor, SettingsAccessProvider } from './access';
import { AppearanceRow } from './AppearanceRow';

const root = document.documentElement;

// Unmount first, so resetting the attribute does not update a mounted row.
afterEach(() => {
  cleanup();
  delete root.dataset.theme;
  localStorage.clear();
});

function radio(name: string): HTMLElement {
  return screen.getByRole('radio', { name });
}

function checkedRadio(): string | null {
  const group = screen.getByRole('radiogroup', { name: 'Theme' });
  const checked = Array.from(group.querySelectorAll('[role="radio"]')).find(
    (el) => el.getAttribute('aria-checked') === 'true'
  );
  return checked?.textContent ?? null;
}

describe('AppearanceRow', () => {
  test('it renders the Theme radiogroup under an Appearance heading', () => {
    render(<AppearanceRow />);
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeDefined();
    expect(
      screen
        .getAllByRole('radio')
        .map((el) => el.getAttribute('aria-label') ?? el.textContent)
    ).toEqual(['System', 'Light', 'Dark']);
  });

  // localStorage is per origin (each daemon port in a browser), so the copy
  // promises this browser, as Diff display's does, never this computer.
  test('it says the choice is saved in this browser only', () => {
    const { container } = render(<AppearanceRow />);
    expect(container.textContent).toContain(
      'Saved in this browser only. Nothing here changes the project.'
    );
    expect(container.textContent).not.toContain('this computer');
  });

  for (const [shown, label] of [
    ['light', 'Light'],
    ['dark', 'Dark'],
    ['system', 'System'],
  ] as const) {
    test(`it selects ${label} while html[data-theme] is ${shown}`, () => {
      root.dataset.theme = shown;
      render(<AppearanceRow />);
      expect(checkedRadio()).toBe(label);
    });
  }

  test('with no data-theme it selects System', () => {
    render(<AppearanceRow />);
    expect(checkedRadio()).toBe('System');
  });

  test('it follows a data-theme change made outside it, as the footer toggle does', async () => {
    root.dataset.theme = 'light';
    render(<AppearanceRow />);
    expect(checkedRadio()).toBe('Light');
    await act(async () => {
      root.dataset.theme = 'dark';
      await Promise.resolve();
    });
    expect(checkedRadio()).toBe('Dark');
  });

  test('choosing Dark stores it and shows it', async () => {
    root.dataset.theme = 'system';
    render(<AppearanceRow />);
    await act(async () => {
      fireEvent.click(radio('Dark'));
      await Promise.resolve();
    });
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(checkedRadio()).toBe('Dark');
  });

  test('choosing System removes the stored choice and shows system', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    root.dataset.theme = 'light';
    render(<AppearanceRow />);
    await act(async () => {
      fireEvent.click(radio('System'));
      await Promise.resolve();
    });
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(root.dataset.theme).toBe('system');
    expect(checkedRadio()).toBe('System');
  });

  // The theme is a per-computer preference, not config, so a teammate who
  // may not save config can still choose it.
  test('below the decide tier the group is not locked and the radios stay enabled', async () => {
    root.dataset.theme = 'light';
    render(
      <SettingsAccessProvider access={accessFor('request', false)}>
        <AppearanceRow />
      </SettingsAccessProvider>
    );
    const fieldset = screen
      .getByRole('heading', { name: 'Appearance' })
      .closest('section')
      ?.querySelector('fieldset');
    expect(fieldset?.disabled).toBe(false);
    expect(screen.queryByRole('img', { name: /Can approve/ })).toBeNull();
    for (const name of ['System', 'Light', 'Dark']) {
      expect(radio(name).hasAttribute('disabled')).toBe(false);
    }
    await act(async () => {
      fireEvent.click(radio('Dark'));
      await Promise.resolve();
    });
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});
