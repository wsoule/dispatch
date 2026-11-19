// The Macs this phone is paired with, as the keychain holds them: every Mac's
// keys, and which one the app is talking to. Pure, so the rules (one entry
// per Mac, re-pairing replaces, forgetting the active one picks another) are
// tested without a keychain. src/remote.tsx reads and writes it.

export interface Paired {
  relay: string;
  daemonId: string;
  daemonKey: string;
  daemonName: string;
  phoneSecret: string;
}

export interface MacList {
  /** The daemonId of the Mac in use; null only when `macs` is empty. */
  active: string | null;
  macs: Paired[];
}

export const EMPTY: MacList = { active: null, macs: [] };

/** One stored Mac, or null when a field is missing. */
function parsePaired(value: unknown): Paired | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<Record<keyof Paired, unknown>>;
  return typeof v.relay === 'string' &&
    typeof v.daemonId === 'string' &&
    typeof v.daemonKey === 'string' &&
    typeof v.phoneSecret === 'string'
    ? {
        relay: v.relay,
        daemonId: v.daemonId,
        daemonKey: v.daemonKey,
        daemonName:
          typeof v.daemonName === 'string' ? v.daemonName : 'Your Mac',
        phoneSecret: v.phoneSecret,
      }
    : null;
}

/**
 * The stored list from the keychain's text. Reads today's shape, and the
 * one-Mac shape earlier builds wrote (a single Paired), so an update keeps
 * the Mac the phone already had. Anything unreadable is no Macs.
 */
export function parseMacList(text: string | null): MacList {
  if (text === null) return EMPTY;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return EMPTY;
  }
  const single = parsePaired(value);
  if (single !== null) return { active: single.daemonId, macs: [single] };
  if (typeof value !== 'object' || value === null) return EMPTY;
  const raw = (value as { macs?: unknown; active?: unknown }).macs;
  const macs = Array.isArray(raw)
    ? raw.flatMap((m) => {
        const p = parsePaired(m);
        return p === null ? [] : [p];
      })
    : [];
  const wanted = (value as { active?: unknown }).active;
  const active = macs.some((m) => m.daemonId === wanted)
    ? (wanted as string)
    : (macs[0]?.daemonId ?? null);
  return { active, macs };
}

/** The Mac in use, or null. */
export function activeMac(list: MacList): Paired | null {
  return list.macs.find((m) => m.daemonId === list.active) ?? null;
}

/** Adds a newly paired Mac and makes it the one in use. Pairing a Mac the
 *  phone already knows replaces its old keys rather than listing it twice. */
export function addMac(list: MacList, mac: Paired): MacList {
  return {
    active: mac.daemonId,
    macs: [...list.macs.filter((m) => m.daemonId !== mac.daemonId), mac],
  };
}

/** Switches to a known Mac; an unknown id changes nothing. */
export function selectMac(list: MacList, daemonId: string): MacList {
  return list.macs.some((m) => m.daemonId === daemonId)
    ? { ...list, active: daemonId }
    : list;
}

/** Forgets one Mac. Forgetting the one in use moves to the first left. */
export function removeMac(list: MacList, daemonId: string): MacList {
  const macs = list.macs.filter((m) => m.daemonId !== daemonId);
  const active =
    list.active === daemonId ? (macs[0]?.daemonId ?? null) : list.active;
  return { active, macs };
}

/**
 * How a pairing code relates to the Macs this phone knows: a new Mac, the
 * same Mac again (same id, key and relay), or a known id with a different
 * key or relay. The last is what a code made to pass as one of your Macs
 * looks like (or that Mac was reset), so the pairing screen warns instead of
 * calling it a routine re-pair.
 */
export function offerKind(
  list: MacList,
  offer: { daemonId: string; daemonKey: string; relay: string }
): 'new' | 'same' | 'key-changed' {
  const known = list.macs.find((m) => m.daemonId === offer.daemonId);
  if (known === undefined) return 'new';
  return known.daemonKey === offer.daemonKey && known.relay === offer.relay
    ? 'same'
    : 'key-changed';
}
