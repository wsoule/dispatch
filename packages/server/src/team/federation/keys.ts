import type { ReplicaKeys } from '@dispatch/protocol/federation';
import {
  generateReplicaKeys,
  publicOfPrivate,
} from '@dispatch/protocol/federation';
import { Database } from 'bun:sqlite';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { newReplicaId } from '../boardSync/ledger.js';
import { FED_SCHEMA } from './schema.js';

interface KeyFile extends ReplicaKeys {
  v: 1;
  replica: string;
}

const START_OVER = 'move it aside and join as a new replica';

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
  // Another replica's keys are set aside, never deleted; a returning id gets its own back.
  if (existsSync(file)) {
    const stored = readKeyFile(file);
    if (stored.replica !== replica)
      renameSync(file, retiredPath(dir, stored.replica));
  }
  const ownRetired = retiredFile(dir, replica, 1);
  if (!existsSync(file) && existsSync(ownRetired)) renameSync(ownRetired, file);
  if (!existsSync(file)) writeKeyFile(file, replica);
  enforceMode(file, 0o600, warn);
  const stored = readKeyFile(file);
  if (
    !isPairOf(stored.signPriv, stored.signPub) ||
    !isPairOf(stored.sealPriv, stored.sealPub)
  )
    throw new Error(`${file} does not hold a matching key pair; ${START_OVER}`);
  return {
    signPriv: stored.signPriv,
    signPub: stored.signPub,
    sealPriv: stored.sealPriv,
    sealPub: stored.sealPub,
  };
}

// Before the ledger opens: a chain whose key file is gone or names another
// replica continues as a new replica id. Returns the id it replaced, or null.
export function rekeyIfKeysLost(
  syncDir: string,
  statePath: string,
  handle: string
): string | null {
  if (!existsSync(statePath)) return null;
  const file = join(syncDir, 'keys', 'replica.json');
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
    let holder: string | null = null;
    if (existsSync(file)) {
      // An unreadable file is left for loadOrCreateKeys to refuse with guidance.
      try {
        holder = readKeyFile(file).replica;
      } catch {
        return null;
      }
      if (holder === old.value) return null;
    }
    const next = newReplicaId(handle);
    const why =
      holder === null
        ? 'lost keys/replica.json'
        : `holds ${holder}'s keys in keys/replica.json, not ${old.value}'s,`;
    const revoke = holder === null ? old.value : `${old.value} and ${holder}`;
    // meta.seq stays, so the new id's chain starts past every number used.
    // A state.db from an earlier build may lack the newer federation tables.
    db.exec(FED_SCHEMA);
    db.transaction(() => {
      db.query("UPDATE meta SET value = ? WHERE key = 'replica'").run(next);
      db.query(
        "DELETE FROM fed_meta WHERE key IN ('head_seq', 'head_hash', 'head_hlc', 'pending_invite')"
      ).run();
      // Signed under the old id, so nothing publishes them now; the roster rows
      // they put in this machine's fold go with them.
      db.query(
        'DELETE FROM fed_roster WHERE replica = ? AND seq IN (SELECT seq FROM fed_outbox)'
      ).run(old.value);
      db.query('DELETE FROM fed_outbox').run();
      db.query('DELETE FROM fed_log').run();
      // The old id's agents, channels and presence; the new id publishes its own.
      db.query('DELETE FROM fed_published').run();
      db.query("UPDATE outbox SET op = json_set(op, '$.replica', ?)").run(next);
      db.query(
        'INSERT INTO fed_problems (subject, message, at) VALUES (?, ?, ?) ON CONFLICT (subject) DO UPDATE SET message = excluded.message, at = excluded.at'
      ).run(
        `replica:${old.value}`,
        `This machine ${why} and joins again as ${next}: an admin must admit it, and should revoke ${revoke}. Changes and messages it had not published yet were dropped; make or send them again.`,
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

// Writes new keys through a synced temporary file, so a crash never leaves a
// partial replica.json, and links it in, so an existing key file is never replaced.
function writeKeyFile(file: string, replica: string): void {
  const content = {
    v: 1,
    replica,
    ...generateReplicaKeys(),
    createdAt: new Date().toISOString(),
  };
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(content, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
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
  const refused = new Error(`${file} is not a replica key file; ${START_OVER}`);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw refused;
  const o = parsed as Record<string, unknown>;
  const fields = ['replica', 'signPriv', 'signPub', 'sealPriv', 'sealPub'];
  if (o.v !== 1 || fields.some((f) => typeof o[f] !== 'string')) throw refused;
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

// The nth retired key file for a replica; the first holds its original keys.
function retiredFile(dir: string, replica: string, n: number): string {
  const suffix = n === 1 ? '' : `-${n}`;
  return join(dir, `replica-${replica}.retired${suffix}.json`);
}

// Where a retired replica's key file goes, never over an earlier one.
function retiredPath(dir: string, replica: string): string {
  let n = 1;
  while (existsSync(retiredFile(dir, replica, n))) n++;
  return retiredFile(dir, replica, n);
}
