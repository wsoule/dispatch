import type { ApiContext } from '../api.js';
import type { PairedDevices, PairingCodes } from '../devices.js';
import type { AuthTier } from '../tiers.js';
import { isAuthTier, tierAllows } from '../tiers.js';
import {
  errorResponse,
  jsonResponse,
  readJsonBody,
  readJsonBodyOptional,
} from './http.js';

// Pairing another of the operator's own devices with this daemon — the
// desktop app on another machine, a phone — and unpairing it. See devices.ts
// for why a device is the operator, not a teammate.
//
//   POST   /api/pair/offer   { tier? }       → { code, tier, expiresAt, origins, shared }
//   POST   /api/pair         { code, name? } → { token, device, handle, tier }
//   GET    /api/devices                      → { devices }
//   DELETE /api/devices/:id                  → { ok }
//
// Redeeming a code is the one open route: the device has no credential yet,
// and the code is what stands in for one. The other three are the operator's
// alone.

/** What handleApi hands these routes: the paired devices and the open codes. */
export interface DevicePairing {
  devices: PairedDevices;
  codes: PairingCodes;
}

const MAX_NAME_LENGTH = 64;

/** `text` without C0/C1 control characters, by code unit: a terminal escape
 *  sequence begins with one, so none can survive. */
function withoutControlChars(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0x1f && (c < 0x7f || c > 0x9f)) out += text[i];
  }
  return out;
}

/**
 * Refuses anyone but the operator in person, or null to proceed. A device
 * token speaks for the operator's handle, so letting a teammate (even a
 * decide- or operator-tier one) offer a code would let them mint themselves
 * the owner's identity. The shared agent token and a run's token also name
 * the owner and are refused for the same reason: an agent must not be able to
 * pair itself a human credential.
 */
function rejectNonOperator(ctx: ApiContext): Response | null {
  const caller = ctx.caller;
  if (
    caller === undefined ||
    caller.handle !== ctx.actorContext.member.handle ||
    ctx.viaAgentToken === true ||
    ctx.viaRun !== undefined
  ) {
    return errorResponse(
      403,
      'only the operator pairs devices: run `dispatch pair` on the machine running this daemon (it reads the app token), or use an already-paired device'
    );
  }
  return null;
}

/** Answers the pairing and device routes, or null for any other path. */
export async function pairingRoutes(
  req: Request,
  ctx: ApiContext,
  segments: readonly string[]
): Promise<Response | null> {
  const method = req.method;
  const isPair = segments[0] === 'pair';
  const isDevices = segments[0] === 'devices';
  if (!isPair && !isDevices) return null;
  const pairing = ctx.pairing;
  if (pairing === undefined)
    return errorResponse(503, 'this daemon does not pair devices');

  if (isPair && segments.length === 1 && method === 'POST') {
    return await redeem(req, pairing, ctx.actorContext.member.handle);
  }
  if (
    isPair &&
    segments.length === 2 &&
    segments[1] === 'offer' &&
    method === 'POST'
  ) {
    return rejectNonOperator(ctx) ?? (await offer(req, ctx, pairing.codes));
  }
  if (isDevices && segments.length === 1 && method === 'GET') {
    return (
      rejectNonOperator(ctx) ??
      jsonResponse({ devices: pairing.devices.list() })
    );
  }
  if (isDevices && segments.length === 2 && method === 'DELETE') {
    const refused = rejectNonOperator(ctx);
    if (refused !== null) return refused;
    const id = decodeURIComponent(segments[1]);
    const target = pairing.devices.list().find((d) => d.id === id);
    if (target === undefined) {
      return errorResponse(404, `no paired device ${id}`);
    }
    // Nobody unpairs a device that holds more than they do — a decide-tier
    // phone must not be able to sign the operator's operator-tier laptop
    // out. A device can always unpair itself, its tier being its own.
    const held = ctx.caller?.tier ?? 'request';
    if (!tierAllows(held, target.tier)) {
      return errorResponse(
        403,
        `this credential carries ${held} and cannot unpair a device paired at ${target.tier}`
      );
    }
    pairing.devices.revoke(id);
    // Every socket re-resolves its token on each event; this closes the
    // unpaired device's sockets now rather than at the next event.
    ctx.events.revalidate();
    return jsonResponse({ ok: true });
  }
  return null;
}

async function offer(
  req: Request,
  ctx: ApiContext,
  codes: PairingCodes
): Promise<Response> {
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { tier?: unknown };
  const tier: AuthTier =
    body.tier === undefined ? 'operator' : (body.tier as AuthTier);
  if (!isAuthTier(tier)) {
    return errorResponse(400, "tier must be 'request', 'decide' or 'operator'");
  }
  // Nobody hands a device more than they hold themselves.
  const held = ctx.caller?.tier ?? 'request';
  if (!tierAllows(held, tier)) {
    return errorResponse(
      403,
      `this credential carries ${held} and cannot pair a device at ${tier}`
    );
  }
  return jsonResponse({
    ...codes.offer(tier, ctx.caller?.device ?? null),
    shared: ctx.shared,
    origins: [...ctx.ownOrigins].sort(),
  });
}

async function redeem(
  req: Request,
  pairing: DevicePairing,
  handle: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = (parsed.value ?? {}) as { code?: unknown; name?: unknown };
  if (typeof body.code !== 'string' || body.code.trim() === '') {
    return errorResponse(400, 'expected { code, name? }');
  }
  // Whoever holds a code picks the name, and `dispatch pair list` prints it
  // to a terminal: control characters (escape sequences) never get stored.
  const cleaned =
    typeof body.name === 'string' ? withoutControlChars(body.name).trim() : '';
  const name = cleaned === '' ? 'device' : cleaned.slice(0, MAX_NAME_LENGTH);
  const offered = pairing.codes.redeem(body.code);
  // A code a device offered dies with that device: redeeming it after the
  // device was unpaired would mint one outside the unpairing cascade.
  const result =
    offered.ok &&
    offered.pairedBy !== null &&
    !pairing.devices.list().some((d) => d.id === offered.pairedBy)
      ? ({ ok: false, reason: 'invalid' } as const)
      : offered;
  if (!result.ok) {
    return jsonResponse(
      result.reason === 'expired'
        ? {
            error:
              'that pairing code expired: run `dispatch pair` again for a new one',
            code: 'pair_code_expired',
          }
        : {
            error:
              'pairing code not recognized: codes work once and for 10 minutes; run `dispatch pair` on the daemon’s machine for a new one',
            code: 'pair_code_invalid',
          },
      401
    );
  }
  const { token, device } = pairing.devices.add(
    name,
    result.tier,
    result.pairedBy
  );
  return jsonResponse({
    token,
    device,
    handle,
    tier: device.tier,
  });
}
