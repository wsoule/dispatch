// Everything a paired device may reach through the mobile listener, and
// nothing else.
//
// A paired device speaks for the operator at the tier it was paired with
// (devices.ts), which on the ladder alone would let it read files, dispatch
// runs and land work. That is right for a desktop connecting to a remote
// daemon, and too much for the phone app's job: see what is waiting, answer
// it, get told. The mobile listener faces a tunnel, so it refuses every route
// not listed here, whatever the token's tier.

interface DeviceRoute {
  method: string;
  /** Path segments after `/api/`; `:` marks a single wildcard segment. */
  segments: readonly string[];
}

const DEVICE_ROUTES: readonly DeviceRoute[] = [
  { method: 'GET', segments: ['health'] },
  // The Needs-you list, and answering an item on it.
  { method: 'GET', segments: ['decisions', 'open'] },
  { method: 'POST', segments: ['messages', ':', 'reply'] },
  // The Runs list (metadata only; transcripts and diffs stay off the phone).
  { method: 'GET', segments: ['runs'] },
  // This device itself: who it is and its push subscription.
  { method: 'GET', segments: ['mobile', 'me'] },
  { method: 'GET', segments: ['mobile', 'push', 'key'] },
  { method: 'POST', segments: ['mobile', 'push', 'subscriptions'] },
  { method: 'DELETE', segments: ['mobile', 'push', 'subscriptions'] },
];

/** Whether a device token may make this request. */
export function deviceMayReach(
  method: string,
  segments: readonly string[]
): boolean {
  return DEVICE_ROUTES.some(
    (route) =>
      route.method === method &&
      route.segments.length === segments.length &&
      route.segments.every((s, i) => s === ':' || s === segments[i])
  );
}
