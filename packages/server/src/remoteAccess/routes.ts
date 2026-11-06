import { errorResponse, jsonResponse } from '../api/http.js';
import type { RemoteAccess } from './service.js';

// /api/remote, all at the operator tier (api.ts ELEVATED_ROUTES): pairing a
// phone hands out a way to answer this daemon's gates, so neither an agent
// run's token nor a paired phone may do it.
//
//   GET    /api/remote               status, paired devices, live offer
//   POST   /api/remote/pair          a fresh pairing URL for a QR code
//   DELETE /api/remote/devices/:id   unpair one phone
export function handleRemoteRoute(
  remote: RemoteAccess | null | undefined,
  method: string,
  segments: readonly string[]
): Response | null {
  if (segments[0] !== 'remote') return null;
  if (remote === null || remote === undefined)
    return errorResponse(503, 'remote access is not available on this daemon');
  if (segments.length === 1 && method === 'GET')
    return jsonResponse(remote.status());
  if (segments.length === 2 && segments[1] === 'pair' && method === 'POST') {
    const offer = remote.createOffer();
    return 'error' in offer
      ? errorResponse(409, offer.error)
      : jsonResponse(offer, 201);
  }
  if (
    segments.length === 3 &&
    segments[1] === 'devices' &&
    method === 'DELETE'
  ) {
    return remote.removeDevice(segments[2] ?? '')
      ? jsonResponse({ ok: true })
      : errorResponse(404, 'no paired device with that id');
  }
  return null;
}
