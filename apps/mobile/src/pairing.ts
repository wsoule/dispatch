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
