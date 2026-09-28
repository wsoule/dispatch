import type { ReplicaKeys } from '@dispatch/protocol/federation';
import {
  generateReplicaKeys,
  publicOfPrivate,
} from '@dispatch/protocol/federation';
import { Database } from 'bun:sqlite';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { newReplicaId } from '../boardSync/ledger.js';

interface KeyFile extends ReplicaKeys {
  v: 1;
  replica: string;
}

// This replica's private keys, in its sync directory: keys/ 0700 and
// replica.json 0600, re-applied on every open (spec "Files on disk").
export function loadOrCreateKeys(
  syncDir: string,
  replica: string,
  warn: (message: string) => void = console.warn
): ReplicaKeys {
  const dir = join(syncDir, 'keys');
  const file = join(dir, 'replica.json');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  enforceMode(dir, 0o700, warn);
  // A lost state.db means a new replica id; its old keys are kept aside, never reused.
  if (existsSync(file)) {
    const stored = readKeyFile(file);
    if (stored.replica !== replica)
      renameSync(file, retiredPath(dir, stored.replica));
  }
  if (!existsSync(file)) {
    const keys = generateReplicaKeys();
    const content = {
      v: 1,
      replica,
      ...keys,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
  }
  enforceMode(file, 0o600, warn);
  const stored = readKeyFile(file);
  if (
    !isPairOf(stored.signPriv, stored.signPub) ||
    !isPairOf(stored.sealPriv, stored.sealPub)
  )
    throw new Error(
      `${file} does not hold a matching key pair; move it aside and join as a new replica`
    );
  return {
    signPriv: stored.signPriv,
    signPub: stored.signPub,
    sealPriv: stored.sealPriv,
    sealPub: stored.sealPub,
  };
}

// Before the ledger opens: a state.db holding this replica's own chain but no
// key file starts over as a new replica id, since a new key under the old id
// would halt that log on every teammate. Returns the id it replaced, or null.
export function rekeyIfKeysLost(
  syncDir: string,
  statePath: string,
  handle: string
): string | null {
  if (
    existsSync(join(syncDir, 'keys', 'replica.json')) ||
    !existsSync(statePath)
  )
    return null;
  const db = new Database(statePath);
  try {
    const hasFed =
      db
        .query(
          "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'fed_meta'"
        )
        .get() !== null;
    if (!hasFed) return null;
    const head = db
      .query<{ value: string }, []>(
        "SELECT value FROM fed_meta WHERE key = 'head_seq'"
      )
      .get();
    const old = db
      .query<{ value: string }, []>(
        "SELECT value FROM meta WHERE key = 'replica'"
      )
      .get();
    if (head === null || old === null) return null;
    const next = newReplicaId(handle);
    // meta.seq stays, so the new id's chain starts past every number used.
    db.transaction(() => {
      db.query("UPDATE meta SET value = ? WHERE key = 'replica'").run(next);
      db.query(
        "DELETE FROM fed_meta WHERE key IN ('head_seq', 'head_hash', 'head_hlc', 'pending_invite')"
      ).run();
      // Signed by the lost key under the old id: nothing can publish them now.
      db.query('DELETE FROM fed_outbox').run();
      db.query("UPDATE outbox SET op = json_set(op, '$.replica', ?)").run(next);
      db.query(
        'INSERT INTO fed_problems (subject, message, at) VALUES (?, ?, ?) ON CONFLICT (subject) DO UPDATE SET message = excluded.message, at = excluded.at'
      ).run(
        `replica:${old.value}`,
        `This machine lost keys/replica.json and joins again as ${next}: an admin must admit it, and should revoke ${old.value}. Unpublished signed changes were dropped; edit them again.`,
        new Date().toISOString()
      );
    })();
    return old.value;
  } finally {
    db.close();
  }
}

// A filesystem without POSIX modes logs and carries on (spec "Files on disk").
function enforceMode(
  path: string,
  mode: number,
  warn: (message: string) => void
): void {
  try {
    chmodSync(path, mode);
  } catch (err) {
    warn(
      `dispatchd: could not set mode ${mode.toString(8)} on ${path}: ${(err as Error).message}`
    );
  }
}

// Parses a key file, refusing anything that is not version 1 with its five strings.
function readKeyFile(file: string): KeyFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    parsed = null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`${file} is not a replica key file`);
  const o = parsed as Record<string, unknown>;
  const fields = ['replica', 'signPriv', 'signPub', 'sealPriv', 'sealPub'];
  if (o.v !== 1 || fields.some((f) => typeof o[f] !== 'string'))
    throw new Error(`${file} is not a replica key file`);
  return o as unknown as KeyFile;
}

// False for a private key that does not parse or does not match the public one.
function isPairOf(priv: string, pub: string): boolean {
  try {
    return publicOfPrivate(priv) === pub;
  } catch {
    return false;
  }
}

// Where a retired replica's key file goes, never over an earlier one.
function retiredPath(dir: string, replica: string): string {
  let path = join(dir, `replica-${replica}.retired.json`);
  for (let n = 2; existsSync(path); n++)
    path = join(dir, `replica-${replica}.retired-${n}.json`);
  return path;
}
