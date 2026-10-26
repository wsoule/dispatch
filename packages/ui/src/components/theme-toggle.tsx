'use client';

import type { ReactNode } from 'react';

import styles from './theme-toggle.module.css';

export interface ThemeToggleProps {
  /** localStorage key; must match the one passed to themeScript(). */
  storageKey: string;
}

/* Stateless by design: both glyphs are always rendered (identical markup in
   both themes, so there is nothing to hydrate wrong) and CSS picks the visible
   one. The glyph shown is the mode you would switch TO. Drawn in currentColor
   so it follows the button's own colour: --text-2 at rest, --text on its
   hover fill, in either theme. */
export default function ThemeToggle({
  storageKey,
}: ThemeToggleProps): ReactNode {
  function toggle() {
    const el = document.documentElement;
    // "system" (the OS decides) flips to the opposite of what shows now.
    const dark =
      el.dataset.theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : el.dataset.theme === 'dark';
    const next = dark ? 'light' : 'dark';
    el.dataset.theme = next;
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      /* private mode: the choice simply does not persist */
    }
  }

  return (
    <button type="button" className={styles.toggle} onClick={toggle}>
      <span className="srOnly">Switch between light and dark</span>
      <svg
        className={styles.sun}
        width="14"
        height="14"
        viewBox="0 0 14 14"
        aria-hidden="true"
        focusable="false"
      >
        <circle
          cx="7"
          cy="7"
          r="3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        />
        <g stroke="currentColor" strokeWidth="1">
          <line x1="7" y1="0.5" x2="7" y2="2.5" />
          <line x1="7" y1="11.5" x2="7" y2="13.5" />
          <line x1="0.5" y1="7" x2="2.5" y2="7" />
          <line x1="11.5" y1="7" x2="13.5" y2="7" />
        </g>
      </svg>
      <svg
        className={styles.moon}
        width="14"
        height="14"
        viewBox="0 0 14 14"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M10.2 8.9A4.6 4.6 0 0 1 5.1 3.8c0-.6.1-1.1.3-1.6A4.7 4.7 0 1 0 11.8 8.6c-.5.2-1 .3-1.6.3Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        />
      </svg>
    </button>
  );
}
