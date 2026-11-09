import {
  deleteSubscription,
  fetchPushKey,
  saveSubscription,
} from './mobileApi';

// Turning notifications on and off from the phone. The browser makes the
// subscription (a push-service URL plus the keys the daemon encrypts to); the
// daemon only stores it against this device and sends to it.

/** Whether this browser can take pushes from the app, and if not, what the
 *  person can do about it. iOS only offers Web Push to an app added to the
 *  Home Screen, so a Safari tab there reads `needs-install`. */
export type PushSupport = 'supported' | 'needs-install' | 'unsupported';

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function pushSupport(): PushSupport {
  const capable =
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;
  if (capable) return 'supported';
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  return ios && !isStandalone() ? 'needs-install' : 'unsupported';
}

// The VAPID key arrives base64url; subscribe() wants the raw bytes.
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Asks for permission (this must run inside a tap), subscribes and hands the
 *  subscription to the daemon. Throws with a sentence when it cannot. */
export async function enablePush(token: string): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted')
    throw new Error(
      'Notifications are blocked for this app. Allow them in Settings, then try again.'
    );
  const registration = await navigator.serviceWorker.ready;
  const key = await fetchPushKey(token);
  // A subscription made for another daemon's key cannot be reused: drop it.
  const existing = await registration.pushManager.getSubscription();
  if (existing !== null) await existing.unsubscribe();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(key),
  });
  await saveSubscription(token, subscription.toJSON());
}

/** Unsubscribes here and tells the daemon to stop sending. */
export async function disablePush(token: string): Promise<void> {
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing !== null) await existing.unsubscribe();
  await deleteSubscription(token);
}
