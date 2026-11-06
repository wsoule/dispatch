import { fromBase64Url, toBase64Url } from '@dispatch/remote';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

// remote.json: what this daemon needs to be reached from a phone, kept under
// DISPATCH_HOME beside team-tokens.json, mode 0600.
//
//   secret  the relay sign-in secret; the daemon id phones dial is its hash
//   key     this daemon's X25519 secret key, which phones pinned at pairing
//   devices each paired phone's public key and name
//
// Losing the file unpairs every phone; it never leaves this machine.

export interface StoredDevice {
  id: string;
  name: string;
  publicKey: Uint8Array;
  pairedAt: string;
  lastSeenAt: string | null;
}

export interface RemoteState {
  secret: Uint8Array;
  secretKey: Uint8Array;
  devices: StoredDevice[];
}

interface FileShape {
  v: 1;
  secret: string;
  key: string;
  devices: Array<{
    id: string;
    name: string;
    publicKey: string;
    pairedAt: string;
    lastSeenAt: string | null;
  }>;
}

function parse(text: string): RemoteState | null {
  try {
    const raw = JSON.parse(text) as Partial<FileShape>;
    if (
      raw.v !== 1 ||
      typeof raw.secret !== 'string' ||
      typeof raw.key !== 'string'
    )
      return null;
    const secret = fromBase64Url(raw.secret);
    const secretKey = fromBase64Url(raw.key);
    if (secret.length !== 32 || secretKey.length !== 32) return null;
    const devices: StoredDevice[] = [];
    for (const d of Array.isArray(raw.devices) ? raw.devices : []) {
      if (
        typeof d.id !== 'string' ||
        typeof d.name !== 'string' ||
        typeof d.publicKey !== 'string'
      )
        continue;
      const publicKey = fromBase64Url(d.publicKey);
      if (publicKey.length !== 32) continue;
      devices.push({
        id: d.id,
        name: d.name,
        publicKey,
        pairedAt:
          typeof d.pairedAt === 'string'
            ? d.pairedAt
            : new Date(0).toISOString(),
        lastSeenAt: typeof d.lastSeenAt === 'string' ? d.lastSeenAt : null,
      });
    }
    return { secret, secretKey, devices };
  } catch {
    return null;
  }
}

export interface RemoteStore {
  /** The saved state, or null when there is none yet or it would not parse. */
  load(): RemoteState | null;
  save(state: RemoteState): void;
}

/** remote.json at `path`. An unreadable file is moved aside, not
 *  overwritten in place, and reads as no state (every phone re-pairs). */
export function fileRemoteStore(path: string): RemoteStore {
  return {
    load() {
      if (!existsSync(path)) return null;
      const state = parse(readFileSync(path, 'utf8'));
      if (state === null) {
        const aside = `${path}.unreadable-${Date.now()}`;
        renameSync(path, aside);
        console.error(
          `dispatchd: ${path} was unreadable; moved to ${aside}. Pair your phone again.`
        );
      }
      return state;
    },
    save(state) {
      mkdirSync(dirname(path), { recursive: true });
      const file: FileShape = {
        v: 1,
        secret: toBase64Url(state.secret),
        key: toBase64Url(state.secretKey),
        devices: state.devices.map((d) => ({
          id: d.id,
          name: d.name,
          publicKey: toBase64Url(d.publicKey),
          pairedAt: d.pairedAt,
          lastSeenAt: d.lastSeenAt,
        })),
      };
      const temp = `${path}.tmp-${process.pid}`;
      writeFileSync(temp, JSON.stringify(file, null, 2), { mode: 0o600 });
      try {
        chmodSync(temp, 0o600);
      } catch {
        // A filesystem without POSIX modes is not a reason to fail the write.
      }
      renameSync(temp, path);
    },
  };
}
