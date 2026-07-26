import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

import { isTauri } from './tauri';

// Cached across every `notify` call so the OS permission prompt (and the
// `isPermissionGranted` round trip) only happens once per app session,
// rather than once per notification. `null` means "not checked yet";
// resolves to `true`/`false` once the first call settles, and every
// subsequent call reuses that same settled promise.
let grantedPromise: Promise<boolean> | null = null;

// Checks (and, the first time, requests) OS notification permission,
// caching the result for the lifetime of this window per the module-level
// comment above. A denied permission is cached as `false` too — this app
// never re-prompts, matching the "no settings UI toggle" decision for this
// pass; the user's system notification settings are the opt-out.
function ensurePermission(): Promise<boolean> {
  grantedPromise ??= (async () => {
    if (await isPermissionGranted()) return true;
    const permission = await requestPermission();
    return permission === 'granted';
  })();
  return grantedPromise;
}

/**
 * Fires a native OS notification, or silently does nothing when it isn't
 * appropriate to: outside the Tauri webview (the plain-browser dev harness
 * has no OS to notify), or while the app window already has focus (the user
 * is watching — a notification here would just be spam on top of whatever
 * live UI already shows the same state change). Callers pass a short title
 * (the notification category, e.g. "Run finished") and a body with the
 * specific detail (e.g. the task title) — see notificationEdges.ts for the
 * exact title/body pairs this app sends.
 */
export async function notify(title: string, body: string): Promise<void> {
  if (!isTauri()) return;
  if (document.hasFocus()) return;
  const granted = await ensurePermission();
  if (!granted) return;
  // Re-check focus after the await above: the very permission prompt this awaited
  // (on the session's first-ever call) can itself re-focus the window once the user
  // dismisses it, so the "user is watching" check from before the await can be stale
  // by the time we're about to actually fire.
  if (document.hasFocus()) return;
  try {
    sendNotification({ title, body });
  } catch (err) {
    // Never let a notification failure (e.g. the OS notification center rejecting the
    // call) propagate to `notify`'s caller — every call site here fires this with
    // `void notify(...)` precisely because a notification is a best-effort side
    // channel, not something a transition-handling code path should ever throw over.
    console.error('notify: sendNotification failed', err);
  }
}
