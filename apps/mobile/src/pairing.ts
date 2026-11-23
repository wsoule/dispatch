import { type PairingOffer, parsePairingUrl } from '@dispatch/remote';

// A pairing link opened from the system camera reaches the pair screen as
// expo-router search params, already decoded. This puts the URL back together
// so it goes through the same parsePairingUrl check as a scanned code.

const PARAMS = ['v', 'r', 'd', 'k', 'o', 'c', 'n'] as const;

/** The pairing URL rebuilt from a deep link's params, or null when they
 *  carry no pairing code. Anything else in the params is dropped. */
export function urlFromParams(
  params: Partial<Record<string, string | string[]>>
): string | null {
  const query = new URLSearchParams();
  for (const name of PARAMS) {
    const value = params[name];
    if (typeof value === 'string') query.set(name, value);
  }
  return query.has('c') ? `dispatch-remote://pair?${query.toString()}` : null;
}

const WRONG_CODE =
  'That is the code for pairing another Dispatch app, not this iPhone. On your Mac, open Settings › Devices and choose Show code under iPhone.';

const NOT_A_CODE =
  'That is not a Dispatch pairing link. On your Mac, open Settings › Devices and choose Show code under iPhone, then scan it or paste its link.';

/**
 * A pairing offer out of whatever was pasted or scanned, or a reason a
 * person can act on. People paste the link with text around it, wrapped
 * across lines by a terminal, or percent-encoded by a chat app, so the link
 * is found inside the text first. The desktop also shows a different code
 * (dispatch://pair?…, or ABCD-EFGH) for pairing another copy of the app;
 * that one gets told apart, since it is the easy one to grab by mistake.
 */
export function readPairingText(
  text: string
): { ok: true; offer: PairingOffer } | { ok: false; error: string } {
  let flat = text.replace(/\s+/g, '');
  if (/^dispatch-remote%3A/i.test(flat)) {
    try {
      flat = decodeURIComponent(flat);
    } catch {
      return { ok: false, error: NOT_A_CODE };
    }
  }
  const found = /dispatch-remote:\/\/pair\?[^\s"'<>]+/.exec(flat);
  if (found !== null) {
    const parsed = parsePairingUrl(found[0]);
    return parsed.ok
      ? parsed
      : { ok: false, error: `That pairing link is unusable: ${parsed.error}.` };
  }
  if (
    /dispatch:\/\/pair\?/.test(flat) ||
    /^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(flat)
  )
    return { ok: false, error: WRONG_CODE };
  return { ok: false, error: NOT_A_CODE };
}
