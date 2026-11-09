import type { Message, RunMeta } from '@dispatch/client';

// The phone app's whole conversation with dispatchd. It talks to the mobile
// listener on its own origin (the tunnel URL the phone opened), so every path
// is relative, and its only credential is the device token pairing handed it,
// sent as a bearer header and never as a cookie.
//
// The token lives in localStorage. The service worker never needs it: it only
// shows notifications and opens the app, and the page does every
// authenticated call.

const TOKEN_KEY = 'dispatch.mobile.token';
const DEVICE_KEY = 'dispatch.mobile.device';

export interface PairedPhone {
  token: string;
  device: string;
}

export function loadPairing(
  storage: Storage = localStorage
): PairedPhone | null {
  const token = storage.getItem(TOKEN_KEY);
  const device = storage.getItem(DEVICE_KEY);
  return token === null || device === null ? null : { token, device };
}

export function savePairing(
  pairing: PairedPhone,
  storage: Storage = localStorage
): void {
  storage.setItem(TOKEN_KEY, pairing.token);
  storage.setItem(DEVICE_KEY, pairing.device);
}

export function forgetPairing(storage: Storage = localStorage): void {
  storage.removeItem(TOKEN_KEY);
  storage.removeItem(DEVICE_KEY);
}

/** The pairing code a link carried in its fragment (`#pair=ABCD-EFGH`), or
 *  null. A fragment never reaches a server, so the code stays out of the
 *  tunnel's logs. */
export function pairCodeFromHash(hash: string): string | null {
  const match = /(?:^#|&)pair=([^&]+)/.exec(hash);
  return match === null ? null : decodeURIComponent(match[1]);
}

/** A failed call, carrying the daemon's own sentence for it. */
export class MobileApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(
  path: string,
  init: RequestInit & { token?: string } = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.token !== undefined)
    headers.set('authorization', `Bearer ${init.token}`);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  const body = text === '' ? null : (JSON.parse(text) as unknown);
  if (!res.ok) {
    const error =
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'string'
        ? body.error
        : `request failed (${res.status})`;
    throw new MobileApiError(res.status, error);
  }
  return body as T;
}

/** Redeems a pairing code for this phone's device token. */
export async function pair(code: string, name: string): Promise<PairedPhone> {
  const answer = await call<{ token: string; device: { id: string } }>(
    '/api/pair',
    { method: 'POST', body: JSON.stringify({ code: code.trim(), name }) }
  );
  return { token: answer.token, device: answer.device.id };
}

export function fetchDecisions(token: string): Promise<Message[]> {
  return call<{ items: Message[] }>('/api/decisions/open', { token }).then(
    (r) => r.items
  );
}

export function fetchRuns(token: string): Promise<RunMeta[]> {
  return call<RunMeta[]>('/api/runs', { token });
}

/** Answers a question or gate: with one of its choices, or in words. */
export function answer(
  token: string,
  messageId: string,
  reply: { choice?: string; body: string }
): Promise<unknown> {
  return call(`/api/messages/${encodeURIComponent(messageId)}/reply`, {
    method: 'POST',
    token,
    body: JSON.stringify(reply),
  });
}

export function fetchPushKey(token: string): Promise<string> {
  return call<{ publicKey: string }>('/api/mobile/push/key', { token }).then(
    (r) => r.publicKey
  );
}

export function fetchMe(
  token: string
): Promise<{ device: string; push: boolean }> {
  return call('/api/mobile/me', { token });
}

export function saveSubscription(
  token: string,
  subscription: PushSubscriptionJSON
): Promise<unknown> {
  return call('/api/mobile/push/subscriptions', {
    method: 'POST',
    token,
    body: JSON.stringify(subscription),
  });
}

export function deleteSubscription(token: string): Promise<unknown> {
  return call('/api/mobile/push/subscriptions', { method: 'DELETE', token });
}

// Runs the person is waiting on, or may be about to be.
const LIVE_STATES = new Set(['provisioning', 'running', 'awaiting-approval']);
// How far back finished runs stay on the phone's list.
const RECENT_MS = 24 * 3600_000;

/** The Runs list, as the phone shows it: live runs first, newest first, then
 *  the last day's finished ones. Archived runs never show. */
export function runsForPhone(
  runs: readonly RunMeta[],
  now: number = Date.now()
): { live: RunMeta[]; recent: RunMeta[] } {
  const newest = (a: RunMeta, b: RunMeta) =>
    b.updatedAt.localeCompare(a.updatedAt);
  const visible = runs.filter((r) => r.archivedAt === undefined);
  return {
    live: visible.filter((r) => LIVE_STATES.has(r.state)).sort(newest),
    recent: visible
      .filter(
        (r) =>
          !LIVE_STATES.has(r.state) && now - Date.parse(r.updatedAt) < RECENT_MS
      )
      .sort(newest),
  };
}

/** A word for a run's state that a person reads at a glance. */
export function runStateLabel(run: RunMeta): string {
  switch (run.state) {
    case 'provisioning':
      return 'Starting';
    case 'running':
      return 'Running';
    case 'awaiting-approval':
      return 'Waiting on you';
    case 'finished':
      return run.reviewedAt === undefined ? 'Ready for review' : 'Done';
    case 'failed':
    case 'interrupted-dirty':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return run.state;
  }
}
