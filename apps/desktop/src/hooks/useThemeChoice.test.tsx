import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { THEME_STORAGE_KEY } from '../lib/theme';
import {
  followThemeFromOtherWindows,
  setThemeChoice,
  useThemeChoice,
} from './useThemeChoice';

const root = document.documentElement;

// Unmount first, so resetting the attribute does not update a mounted hook.
afterEach(() => {
  cleanup();
  delete root.dataset.theme;
  root.removeAttribute('data-theme-switching');
  localStorage.clear();
});

// MutationObserver reports on a microtask, so a change is awaited inside act.
async function settle(change: () => void) {
  await act(async () => {
    change();
    await Promise.resolve();
  });
}

function storageEvent(key: string | null, newValue: string | null) {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue }));
}

describe('useThemeChoice', () => {
  test('it reads html[data-theme] and follows a mutation of it', async () => {
    root.dataset.theme = 'light';
    const { result } = renderHook(() => useThemeChoice());
    expect(result.current).toBe('light');
    await settle(() => {
      root.dataset.theme = 'dark';
    });
    expect(result.current).toBe('dark');
    await settle(() => {
      delete root.dataset.theme;
    });
    expect(result.current).toBe('system');
  });

  // followThemeFromOtherWindows writes the attribute; the hook reports it.
  test('it follows a choice another window makes', async () => {
    root.dataset.theme = 'system';
    const stop = followThemeFromOtherWindows();
    try {
      const { result } = renderHook(() => useThemeChoice());
      await settle(() => storageEvent(THEME_STORAGE_KEY, 'dark'));
      expect(result.current).toBe('dark');
    } finally {
      stop();
    }
  });
});

// No hook is mounted in any of these: the listener is the page's own, so a
// gate screen with no settings control or palette still follows.
describe('followThemeFromOtherWindows', () => {
  let stop: () => void = () => {};
  beforeEach(() => {
    stop = followThemeFromOtherWindows();
  });
  afterEach(() => {
    stop();
    root.removeAttribute('data-theme-switching');
  });

  test('a storage event for the key applies light, dark or system here', () => {
    root.dataset.theme = 'system';
    storageEvent(THEME_STORAGE_KEY, 'light');
    expect(root.dataset.theme).toBe('light');
    storageEvent(THEME_STORAGE_KEY, 'dark');
    expect(root.dataset.theme).toBe('dark');
    // Another window chose System: the key was removed.
    storageEvent(THEME_STORAGE_KEY, null);
    expect(root.dataset.theme).toBe('system');
    // It applies, never stores.
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  // Through showTheme, so the change does not animate.
  test('it swaps the theme with transitions off', () => {
    root.dataset.theme = 'light';
    storageEvent(THEME_STORAGE_KEY, 'dark');
    expect(root.hasAttribute('data-theme-switching')).toBe(true);
  });

  test('a storage clear (null key) falls back to system', () => {
    root.dataset.theme = 'dark';
    storageEvent(null, null);
    expect(root.dataset.theme).toBe('system');
  });

  test('a storage event for another key is ignored', () => {
    root.dataset.theme = 'dark';
    storageEvent('dispatch:other', 'light');
    expect(root.dataset.theme).toBe('dark');
  });

  test('once stopped, a storage event no longer applies', () => {
    root.dataset.theme = 'dark';
    stop();
    storageEvent(THEME_STORAGE_KEY, 'light');
    expect(root.dataset.theme).toBe('dark');
  });
});

describe('setThemeChoice', () => {
  test('light and dark are stored and shown', () => {
    setThemeChoice('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
    setThemeChoice('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(root.dataset.theme).toBe('light');
  });

  test('system removes the key and shows system', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    setThemeChoice('system');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(root.dataset.theme).toBe('system');
  });
});
