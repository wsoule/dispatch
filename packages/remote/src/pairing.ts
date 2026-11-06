import { fromBase64Url, toBase64Url } from './bytes.js';
import { isDaemonId } from './wire.js';

// What a pairing QR code carries, as the URL the phone's camera opens. All of
// it but the code is public: the relay URL, the daemon's relay id and public
// key, which offer this is, and the name the phone lists it under. The code
// is the one secret, single-use and short-lived, and it never crosses the
// relay: it only feeds the handshake's key derivation (handshake.ts).

export const PAIRING_SCHEME = 'dispatch-remote:';

/** One pairing offer as the phone reads it out of a QR code. */
export interface PairingOffer {
  relay: string;
  daemonId: string;
  daemonKey: Uint8Array;
  offerId: string;
  code: Uint8Array;
  /** The project or machine, as the daemon names itself. */
  name: string;
}

/** The URL a QR code shows for an offer. */
export function pairingUrl(offer: PairingOffer): string {
  const params = new URLSearchParams({
    v: '1',
    r: offer.relay,
    d: offer.daemonId,
    k: toBase64Url(offer.daemonKey),
    o: offer.offerId,
    c: toBase64Url(offer.code),
    n: offer.name,
  });
  return `${PAIRING_SCHEME}//pair?${params.toString()}`;
}

/**
 * An offer back from a scanned URL, or why it is not one. The relay URL must
 * be wss:// (ws:// only for this machine, for tests and local relays), since
 * the relay's TLS is what keeps the daemon's relay secret off the network.
 */
export function parsePairingUrl(
  text: string
): { ok: true; offer: PairingOffer } | { ok: false; error: string } {
  const prefix = `${PAIRING_SCHEME}//pair?`;
  if (!text.startsWith(prefix))
    return { ok: false, error: 'not a Dispatch pairing code' };
  const params = new URLSearchParams(text.slice(prefix.length));
  if (params.get('v') !== '1')
    return { ok: false, error: 'this code needs a newer version of the app' };
  const relay = params.get('r') ?? '';
  if (!isAllowedRelay(relay))
    return { ok: false, error: 'the code names a relay that is not wss://' };
  const daemonId = params.get('d') ?? '';
  const offerId = params.get('o') ?? '';
  const name = (params.get('n') ?? '').slice(0, 80);
  if (!isDaemonId(daemonId) || !/^[0-9a-f]{16}$/.test(offerId))
    return { ok: false, error: 'the code is damaged' };
  try {
    const daemonKey = fromBase64Url(params.get('k') ?? '');
    const code = fromBase64Url(params.get('c') ?? '');
    if (daemonKey.length !== 32 || code.length !== 32)
      return { ok: false, error: 'the code is damaged' };
    return {
      ok: true,
      offer: {
        relay,
        daemonId,
        daemonKey,
        offerId,
        code,
        name: name === '' ? 'Dispatch' : name,
      },
    };
  } catch {
    return { ok: false, error: 'the code is damaged' };
  }
}

/** wss:// anywhere, ws:// only on loopback. */
export function isAllowedRelay(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'wss:') return true;
  return (
    parsed.protocol === 'ws:' &&
    (parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '[::1]')
  );
}
