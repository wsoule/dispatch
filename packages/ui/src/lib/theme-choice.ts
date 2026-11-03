// The DOM side of the stored theme: read and apply a person's choice under
// the same localStorage key that themeScript() and ThemeToggle use. Only
// 'light' or 'dark' is ever stored; no key means follow the OS
// (html[data-theme="system"]). Kept apart from ./theme, which must stay
// DOM-free for Node.
import { type ThemeChoice, themeChoiceOf } from './theme';

// The pending frame that ends the current theme swap (see showTheme), and
// how many holdThemeSwitch() holds still keep it from ending.
let swapEnd = 0;
let holds = 0;

// Takes html[data-theme-switching] off two frames from now (the frame that
// first paints the new colours, then one more), unless a hold still needs
// it. A later call restarts the wait.
function endSwapSoon(): void {
  const root = document.documentElement;
  cancelAnimationFrame(swapEnd);
  swapEnd = requestAnimationFrame(() => {
    swapEnd = requestAnimationFrame(() => {
      if (holds === 0) root.removeAttribute('data-theme-switching');
    });
  });
}

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
  endSwapSoon();
}

/**
 * Keeps transitions off (html[data-theme-switching]) from now until the
 * returned release is called, then for two more frames, as showTheme does;
 * showTheme's own end waits for every hold. For a swap the page cannot finish
 * in one frame: a desktop webview whose `prefers-color-scheme` follows its
 * native window, which changes only after a call to the native side lands.
 * Releasing twice does nothing.
 */
export function holdThemeSwitch(): () => void {
  holds += 1;
  document.documentElement.setAttribute('data-theme-switching', '');
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    holds -= 1;
    endSwapSoon();
  };
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
