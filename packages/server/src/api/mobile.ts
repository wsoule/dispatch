import type { ApiContext } from '../api.js';
import { parseMobileSettings } from '../mobile/host.js';
import { isPushSubscription } from '../mobile/webPush.js';
import { errorResponse, jsonResponse, readJsonBody } from './http.js';

// /api/mobile/* — the mobile listener's settings and phones' push
// notifications (the Doc `mobile-app-spec`).
//
// Two audiences share the prefix:
// - the operator, at this machine, sets the mobile listener up (operator
//   tier, via ELEVATED_ROUTES in api.ts);
// - a paired device reads who it is and subscribes to pushes (device tokens
//   only, checked here; mobile/allowlist.ts keeps the phone to these).
//
// Pairing and unpairing are the daemon's paired-devices routes (`/api/pair`,
// `/api/devices`), shared with remote desktop connections.

export async function handleMobile(
  req: Request,
  ctx: ApiContext,
  segments: readonly string[]
): Promise<Response> {
  const mobile = ctx.mobile;
  if (mobile === undefined)
    return errorResponse(404, 'the mobile app is not available on this daemon');
  const method = req.method;
  const [, first, second] = segments;

  // ---- operator --------------------------------------------------------
  if (first === 'settings' && segments.length === 2) {
    if (method === 'GET') return jsonResponse(mobile.status());
    if (method === 'PUT') {
      const body = await readJsonBody(req);
      if (!body.ok) return body.response;
      const parsed = parseMobileSettings(body.value);
      if (!parsed.ok) return errorResponse(400, parsed.error);
      return jsonResponse(mobile.configure(parsed.settings));
    }
  }

  // ---- a paired device -------------------------------------------------
  const device = ctx.caller?.device;
  if (first === 'me' || first === 'push') {
    if (device === undefined)
      return errorResponse(403, 'only a paired device can use this route');
    if (first === 'me' && segments.length === 2 && method === 'GET')
      return jsonResponse({ device, push: mobile.subscribed(device) });
    if (first === 'push' && second === 'key' && method === 'GET')
      return jsonResponse({ publicKey: mobile.vapid().publicKey });
    if (first === 'push' && second === 'subscriptions') {
      if (method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.ok) return body.response;
        if (!isPushSubscription(body.value))
          return errorResponse(
            400,
            'expected a push subscription: { endpoint: "https://…", keys: { p256dh, auth } }'
          );
        mobile.subscriptions.put(device, body.value);
        return jsonResponse({ subscribed: true }, 201);
      }
      if (method === 'DELETE') {
        mobile.subscriptions.removeDevice(device);
        return jsonResponse({ subscribed: false });
      }
    }
  }

  return errorResponse(404, `no route ${method} /api/${segments.join('/')}`);
}
