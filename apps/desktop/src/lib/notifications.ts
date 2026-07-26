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
  sendNotification({ title, body });
}
