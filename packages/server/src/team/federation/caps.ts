import type { FedStore } from './store.js';

// FW-R39: what a build speaks, announced in its key op and re-announced in
// presence when it changes. A gate reads the capability, never a version.

/** What this build speaks. */
export const BUILD_CAPS: readonly string[] = ['relay'];

const MAX_CAPS = 16;
const MAX_CAP_CHARS = 32;
const CAP = /^[a-z][a-z0-9-]*$/;

/** A caps list off the wire, or null when it is not one. */
export function readCaps(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_CAPS) return null;
  const out: string[] = [];
  for (const c of v) {
    if (typeof c !== 'string' || c.length > MAX_CAP_CHARS || !CAP.test(c))
      return null;
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** Records the caps a verified key op carries, under the key that signed it. */
export function recordKeyCaps(
  fed: FedStore,
  replica: string,
  signPub: string,
  caps: unknown
): void {
  fed.db
    .query(
      'INSERT OR REPLACE INTO fed_caps_keys (replica, sign_pub, caps_json) VALUES (?, ?, ?)'
    )
    .run(replica, signPub, JSON.stringify(readCaps(caps) ?? []));
}

/** Records the caps a replica's latest presence re-announced. */
export function recordPresenceCaps(
  fed: FedStore,
  replica: string,
  caps: readonly string[],
  hlc: string
): void {
  fed.db
    .query(
      'INSERT INTO fed_caps_presence (replica, caps_json, hlc) VALUES (?, ?, ?) ON CONFLICT (replica) DO UPDATE SET caps_json = excluded.caps_json, hlc = excluded.hlc WHERE excluded.hlc > fed_caps_presence.hlc'
    )
    .run(replica, JSON.stringify(caps), hlc);
}

/** What a replica speaks: its latest presence re-announcement, else its
 *  decided key op's; none when it announced nothing. */
export function capsOf(fed: FedStore, replica: string): string[] {
  const announced = fed.db
    .query<{ caps_json: string }, [string]>(
      'SELECT caps_json FROM fed_caps_presence WHERE replica = ?'
    )
    .get(replica);
  if (announced !== null) return JSON.parse(announced.caps_json) as string[];
  const signPub = fed.pinned(replica)?.signPub;
  if (signPub === undefined) return [];
  const keyed = fed.db
    .query<{ caps_json: string }, [string, string]>(
      'SELECT caps_json FROM fed_caps_keys WHERE replica = ? AND sign_pub = ?'
    )
    .get(replica, signPub);
  return keyed === null ? [] : (JSON.parse(keyed.caps_json) as string[]);
}
