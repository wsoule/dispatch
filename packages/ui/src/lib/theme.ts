// Theme helpers that run anywhere, Node included: this module touches no DOM
// and imports nothing, so a Vite config can import it at build time (as
// '@dispatch/ui/lib/theme.ts', never the package index) to inline
// themeScript(). The DOM side, readThemeChoice and applyThemeChoice, lives
// in ./theme-choice.

/**
 * A person's theme choice. 'system' follows the OS live through
 * html[data-theme="system"]; 'light' and 'dark' override it.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

// Parses a stored value: 'light' and 'dark' are themselves, anything else
// (nothing, '', 'system', an unknown word) means follow the OS.
export function themeChoiceOf(value: string | null | undefined): ThemeChoice {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/**
 * Parser-blocking script for the first thing in <body>: a saved 'light' or
 * 'dark' under `storageKey` wins and is written to html[data-theme] before
 * first paint, so there is no flash of the wrong theme. Without a saved
 * choice, `fallback` decides:
 *
 * - 'os' (the default): the OS preference read once through matchMedia, and
 *   'light' when storage throws (private mode).
 * - 'system': data-theme="system", so tokens.css follows
 *   prefers-color-scheme live; a missing, 'system', empty or unknown value
 *   and a storage throw all land here.
 *
 * The emitted code is ES5 (var and function expressions only) so it runs on
 * the oldest WebKit a host supports; the key goes in through JSON.stringify.
 */
export function themeScript(
  storageKey: string,
  opts?: { fallback?: 'os' | 'system' }
): string {
  const key = JSON.stringify(storageKey);
  const followSystem = opts?.fallback === 'system';
  const unset = followSystem
    ? '"system"'
    : 'window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"';
  const failed = followSystem ? '"system"' : '"light"';
  return `(function(){try{var t=localStorage.getItem(${key});if(t!=="dark"&&t!=="light"){t=${unset};}document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme=${failed};}})();`;
}
