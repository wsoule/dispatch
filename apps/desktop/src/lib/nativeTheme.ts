import { holdThemeSwitch, type ThemeChoice, themeChoiceOf } from '@dispatch/ui';
import { getCurrentWindow, type Theme } from '@tauri-apps/api/window';

import { isTauri } from './tauri';

/** The native appearance for a page theme: a chosen Light or Dark pins the
 *  window to it; System is null, which hands the window back to the OS. */
export function nativeThemeFor(choice: ThemeChoice): Theme | null {
  return choice === 'system' ? null : choice;
}

// How long after setTheme(null) lands the page waits for the webview's
// prefers-color-scheme to change before giving transitions back: no change
// comes when the OS already showed the theme the window was pinned to.
const SCHEME_SETTLE_MS = 300;

/** A hold on the theme swap while the webview's colour scheme catches up. */
interface SchemeHold {
  /** The native call landed: wait SCHEME_SETTLE_MS more at most. */
  landed: () => void;
  /** Give transitions back now (the scheme changed, the call failed, or a
   *  newer theme replaced this one). */
  done: () => void;
}

/* Once setTheme pins the window, the webview's prefers-color-scheme follows
   the window, not the OS. Handing it back (System) writes
   data-theme="system" at once, but the media query, which tokens.css reads
   for "system", flips only after the native call lands and the OS pushes
   its appearance. That flip would animate every colour transition, so this
   holds html[data-theme-switching] (holdThemeSwitch) until the query's next
   change, or SCHEME_SETTLE_MS after the call lands if none comes. */
function holdUntilSchemeSettles(): SchemeHold {
  const release = holdThemeSwitch();
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = () => {
    query.removeEventListener('change', done);
    clearTimeout(timer);
    release();
  };
  query.addEventListener('change', done);
  return {
    landed: () => {
      clearTimeout(timer);
      timer = setTimeout(done, SCHEME_SETTLE_MS);
    },
    done,
  };
}

/**
 * Keeps the Tauri window's native appearance (the window background where
 * the page has not painted, the area a resize exposes, native context menus
 * and dialogs, the overlay title bar) in step with the page's theme. It
 * reads html[data-theme], set before first paint by the inline theme script,
 * applies it once now, then again on every change of the attribute: every
 * way the theme changes lands there (the footer ThemeToggle, Settings and
 * the palette through setThemeChoice, another window through
 * followThemeFromOtherWindows), so no caller has to remember to call it.
 * An unchanged value is not sent again, and a window handed back to the OS
 * keeps colour transitions off until the page's scheme has caught up
 * (holdUntilSchemeSettles). Outside Tauri (a browser on `dispatch ui`, plain
 * Vite) there is no native window and it does nothing. Returns the function
 * that stops following.
 */
export function followThemeInNativeWindow(
  inTauri: boolean = isTauri()
): () => void {
  if (!inTauri) return () => undefined;
  const root = document.documentElement;
  let sent: Theme | null | undefined;
  let hold: SchemeHold | null = null;
  const sync = () => {
    const next = nativeThemeFor(themeChoiceOf(root.dataset.theme));
    if (next === sent) return;
    const pinned = sent !== undefined && sent !== null;
    sent = next;
    hold?.done();
    const current = pinned && next === null ? holdUntilSchemeSettles() : null;
    hold = current;
    // Linux and macOS apply it app-wide; there is one window either way.
    getCurrentWindow()
      .setTheme(next)
      .then(
        () => current?.landed(),
        (err: unknown) => {
          current?.done();
          // The page keeps its theme; only the native chrome stays on the OS.
          console.error('theme: setting the window appearance failed', err);
        }
      );
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    observer.disconnect();
    hold?.done();
  };
}
