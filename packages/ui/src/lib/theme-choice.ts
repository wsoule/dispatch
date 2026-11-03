// The DOM side of the stored theme: read and apply a person's choice under
// the same localStorage key that themeScript() and ThemeToggle use. Only
// 'light' or 'dark' is ever stored; no key means follow the OS
// (html[data-theme="system"]). Kept apart from ./theme, which must stay
// DOM-free for Node.
import { type ThemeChoice, themeChoiceOf } from './theme';

// The pending frame that ends the current theme swap (see showTheme).
let swapEnd = 0;

// Writes `theme` to html[data-theme] without animating the change. Many
// rows, buttons and links transition their colours over --dur, so a bare
// attribute swap snaps the surfaces to the new theme while those fade in
// behind them. html[data-theme-switching] turns every transition off
// (tokens.css) for the frame that first paints the new theme, and comes off
// one frame later, once the new colours are the computed ones: removing it
// in the first frame would land in the same style pass as the swap, and the
// colours would animate anyway. A second swap before then restarts the wait.
export function showTheme(theme: string): void {
  const root = document.documentElement;
  root.setAttribute('data-theme-switching', '');
  root.dataset.theme = theme;
  cancelAnimationFrame(swapEnd);
  swapEnd = requestAnimationFrame(() => {
    swapEnd = requestAnimationFrame(() => {
      root.removeAttribute('data-theme-switching');
    });
  });
}

// The stored choice, or 'system' when nothing usable is stored or storage
// throws (private mode, blocked site data).
export function readThemeChoice(storageKey: string): ThemeChoice {
  try {
    return themeChoiceOf(localStorage.getItem(storageKey));
  } catch {
    return 'system';
  }
}

// Shows `choice` at once on html[data-theme] (through showTheme, so nothing
// animates), then saves it: 'light' and 'dark' are stored, 'system' removes
// the key. The attribute is set first so the theme still changes when
// storage throws; the choice then lasts only until the page reloads.
export function applyThemeChoice(
  storageKey: string,
  choice: ThemeChoice
): void {
  showTheme(choice);
  try {
    if (choice === 'system') {
      localStorage.removeItem(storageKey);
    } else {
      localStorage.setItem(storageKey, choice);
    }
  } catch {
    /* private mode: the choice simply does not persist */
  }
}
