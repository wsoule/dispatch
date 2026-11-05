import { isTauri, openUrl } from './tauri';

// "Sign in with Linear" opens Linear's consent page outside this window: the
// system browser in the desktop app, a new tab in the browser UI. The daemon
// answers the URL to open; this module checks it before anything opens, so a
// daemon answer (or a bug) can never send the person somewhere else.

/** Every consent URL the daemon answers starts with this. */
const LINEAR_AUTHORIZE_PREFIX = 'https://linear.app/oauth/authorize?';

/** Why nothing opened: the URL was not Linear's consent page. */
export const LINEAR_SIGN_IN_URL_REFUSED =
  'Dispatch did not open the sign-in page, because the address it got was not Linear’s. Nothing was sent anywhere.';

/** Why nothing opened: the browser blocked the new tab. */
export const LINEAR_SIGN_IN_TAB_BLOCKED =
  'Your browser blocked the sign-in tab. Allow pop-ups for this page, then sign in again.';

/**
 * Whether `url` is a consent page this window may open. The desktop app
 * opens only Linear's own authorize page. The browser UI also accepts the
 * same path on a 127.0.0.1 origin, which is where the fake Linear of a
 * smoke test (DISPATCH_LINEAR_FAKE_ORIGIN) serves it.
 */
export function isLinearSignInUrl(
  url: string,
  surface: 'app' | 'browser'
): boolean {
  // A URL parser drops tabs and newlines silently; refuse them outright.
  if (/\s/.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.pathname !== '/oauth/authorize') return false;
  if (url.startsWith(LINEAR_AUTHORIZE_PREFIX)) {
    return parsed.origin === 'https://linear.app';
  }
  return (
    surface === 'browser' &&
    parsed.protocol === 'http:' &&
    parsed.hostname === '127.0.0.1' &&
    url.startsWith(`${parsed.origin}/oauth/authorize?`)
  );
}

/**
 * Where the consent page will open, settled inside the click that asked:
 * the system browser in the app, or a tab the browser UI opened at once
 * (blank until the daemon answers). A browser blocks a tab opened after an
 * await, so the tab is opened first and pointed at the page later.
 */
export type LinearSignInTarget =
  | { kind: 'app' }
  | { kind: 'tab'; tab: Window }
  | { kind: 'blocked' };

/** Claims the place the consent page will open; call it in the click
 *  handler. `inApp` is whether this is the desktop app (tests name it). */
export function reserveLinearSignIn(
  inApp: boolean = isTauri()
): LinearSignInTarget {
  if (inApp) return { kind: 'app' };
  const tab = window.open('', '_blank');
  return tab === null ? { kind: 'blocked' } : { kind: 'tab', tab };
}

/** Closes a tab reserved for a sign-in that will not happen. */
export function releaseLinearSignIn(target: LinearSignInTarget): void {
  if (target.kind === 'tab') target.tab.close();
}

/**
 * Opens Linear's consent page at `url` in the reserved place, after checking
 * it. Throws, with a message for the person, when the URL is refused (the
 * reserved tab is closed) or the tab was blocked. The tab loses its opener
 * first, so the page it shows cannot reach back into this window. In the app
 * `openExternal` hands the URL to the system browser (Tauri's open_url).
 */
export async function openLinearSignIn(
  url: string,
  target: LinearSignInTarget,
  openExternal: (url: string) => Promise<void> = openUrl
): Promise<void> {
  if (target.kind === 'blocked') throw new Error(LINEAR_SIGN_IN_TAB_BLOCKED);
  if (!isLinearSignInUrl(url, target.kind === 'app' ? 'app' : 'browser')) {
    releaseLinearSignIn(target);
    throw new Error(LINEAR_SIGN_IN_URL_REFUSED);
  }
  if (target.kind === 'app') {
    await openExternal(url);
    return;
  }
  target.tab.opener = null;
  target.tab.location.replace(url);
}
