import {
  applyThemeChoice,
  showTheme,
  type ThemeChoice,
  themeChoiceOf,
} from '@dispatch/ui';
import { useSyncExternalStore } from 'react';

import { THEME_STORAGE_KEY } from '../lib/theme';

// Calls `onChange` whenever html[data-theme] changes. Every change lands on
// the attribute: the footer ThemeToggle and setThemeChoice write it here, and
// followThemeFromOtherWindows writes a choice made in another window. A pure
// observer, so React may subscribe and unsubscribe it as often as it likes.
function subscribeToTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return () => observer.disconnect();
}

// What html[data-theme] shows, read as a choice. The attribute rather than
// storage, because the footer toggle sets it even when storage throws
// (private mode), and the pre-paint script keeps the two in step otherwise.
function readShownTheme(): ThemeChoice {
  return themeChoiceOf(document.documentElement.dataset.theme);
}

// Rendered without a document (no theme to read): the no-script default.
function readServerTheme(): ThemeChoice {
  return 'system';
}

/** The person's theme choice as the page shows it right now, kept current as
 *  the footer toggle, Settings, the palette or another window change it. */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(
    subscribeToTheme,
    readShownTheme,
    readServerTheme
  );
}

/** Shows and saves a theme choice in this browser: 'light' and 'dark' are
 *  stored under THEME_STORAGE_KEY, 'system' removes the key so the theme
 *  follows the OS again. */
export function setThemeChoice(choice: ThemeChoice): void {
  applyThemeChoice(THEME_STORAGE_KEY, choice);
}

/**
 * Shows a theme chosen in another window of this origin (another tab on the
 * same daemon port): `storage` events fire only in the other documents, so
 * one listener for the page, installed at startup by main.tsx, applies the
 * new value to html[data-theme] whatever is mounted, the gate screens
 * included. A null key is a storage clear, which drops the choice too. It
 * never writes storage, so two windows cannot echo a change back and forth.
 * Returns the function that removes the listener.
 */
export function followThemeFromOtherWindows(): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    showTheme(themeChoiceOf(event.newValue));
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
