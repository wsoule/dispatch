import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

// The mobile module's files (paired devices, push subscriptions, the VAPID
// key) are small JSON documents under the project's `~/.dispatch/projects/<key>/`
// directory. Each holds a secret or a hash of one, so each is written 0600
// through a temp file and a rename: a crash leaves the old file or the new
// one, never half of one.

/** Reads a JSON file, or `fallback` when it is missing or will not parse. An
 *  unparsable file is left where it is (the next write replaces it) and
 *  reported once on stderr, since it only ever holds pairings a person can
 *  redo. */
export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    console.error(
      `dispatchd: ${path} is unreadable (${(err as Error).message}); starting from empty`
    );
    return fallback;
  }
}

/** Writes `value` as JSON to `path`, 0600, atomically. */
export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
  } catch {
    // A filesystem without POSIX modes is not a reason to fail the write.
  }
  renameSync(temp, path);
}
