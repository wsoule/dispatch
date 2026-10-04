import type { Hash } from 'node:crypto';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';

// The sync branch is hostile input for the filesystem (FW-R22(1)): anyone with
// push access can commit a symlink or name a device. Every path under the
// clone is lstat-checked before it is read, and this replica's own paths are
// made regular files inside the clone before they are written.

/** Whether `path` is a regular file, not a symlink, device or directory. */
export function regularFile(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/** Whether `path` is a real directory, not a symlink to one. */
export function realDir(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

/** A regular file's text when it is at most `cap` bytes, else null. Opened
 *  without following a link or blocking on a FIFO, and checked by its fd, so
 *  nothing swapped in after a check is read (FW-R22 M-a). */
export function readCapped(path: string, cap: number): string | null {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > cap) return null;
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/** Up to the first `bytes` of a regular file, opened as readCapped opens it. */
export function readHead(path: string, bytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** A real directory's entries, or [] for anything else. */
export function listDir(path: string): string[] {
  return realDir(path) ? readdirSync(path) : [];
}

// Makes root/rel a path this replica may write: every directory on the way a
// real one inside root, and the file itself, if present, a regular file. A
// symlink or other non-file in the way is removed (only from the clone).
export function ownFile(root: string, rel: string): string {
  const base = realpathSync(root);
  const parts = rel.split('/').filter((p) => p !== '');
  let at = base;
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    if (!realDir(at)) {
      rmSync(at, { force: true, recursive: false });
      mkdirSync(at);
    }
  }
  const file = join(at, parts.at(-1) ?? '');
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat !== undefined && !stat.isFile())
    rmSync(file, { force: true, recursive: stat.isDirectory() });
  const parent = realpathSync(dirname(file));
  if (parent !== base && !parent.startsWith(`${base}${sep}`))
    throw new Error(`${rel} would be written outside the sync clone`);
  return file;
}

/** Where a streamed read of one file stands (FW-R29(1)). */
export interface StreamState {
  /** Bytes consumed: every whole line before it was handed out. */
  offset: number;
  /** Inside a line over the cap, discarding to its end. */
  skipping: boolean;
  /** At the end of the file as last read. */
  done: boolean;
  /** The start of a line the last read stopped inside, kept (under the line
   *  cap) so a line longer than one pass's budget still completes. */
  partial: Buffer;
  /** FW-R30(1): the hash of every byte consumed, kept as the read goes. */
  hash: Hash;
  /** Newlines consumed: the whole lines before `offset`. */
  lines: number;
  /** A consumed prefix to check against: when the read reaches `at`, its
   *  hash must equal `digest`; `same` says how it went. */
  verify: { at: number; digest: string; same: boolean | null } | null;
}

export function newStream(
  verify: { at: number; digest: string } | null = null
): StreamState {
  return {
    offset: 0,
    skipping: false,
    done: false,
    partial: Buffer.alloc(0),
    hash: createHash('sha256'),
    lines: 0,
    verify: verify === null ? null : { ...verify, same: null },
  };
}

/** The hash of what a stream has consumed so far. */
export function consumedDigest(state: StreamState): string {
  return state.hash.copy().digest('hex');
}

// Notes a stream reaching, or passing, the prefix it must match.
function checkpoint(state: StreamState, at: number): void {
  const v = state.verify;
  if (v === null || v.same !== null || at < v.at) return;
  v.same = at === v.at && consumedDigest(state) === v.digest;
}

const STREAM_CHUNK = 256 * 1024;

/** Reads `file` from `state.offset`, handing each complete line under
 *  `lineCap` bytes to `onLine` and skipping longer ones, until about `budget`
 *  bytes are read or the file ends. A torn last line waits for its writer.
 *  Opened as readCapped opens a file. Returns the bytes read. */
export function readStream(
  path: string,
  state: StreamState,
  budget: number,
  lineCap: number,
  onLine: (line: string) => void
): number {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch {
    state.done = true;
    return 0;
  }
  let read = 0;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      state.done = true;
      return 0;
    }
    const chunk = Buffer.alloc(STREAM_CHUNK);
    let carry: Buffer = state.partial;
    let at = state.offset;
    state.done = false;
    while (read < budget) {
      const want = Math.min(STREAM_CHUNK, budget - read);
      const n = readSync(fd, chunk, 0, want, at + carry.length);
      if (n === 0) {
        state.done = true;
        break;
      }
      read += n;
      let buf = Buffer.concat([carry, chunk.subarray(0, n)]);
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl < 0) break;
        if (!state.skipping && nl <= lineCap) {
          const line = buf.subarray(0, nl).toString('utf8');
          if (line.trim() !== '') onLine(line);
        }
        state.skipping = false;
        state.hash.update(buf.subarray(0, nl + 1));
        state.lines += 1;
        at += nl + 1;
        checkpoint(state, at);
        buf = buf.subarray(nl + 1);
      }
      if (buf.length > lineCap) {
        // A line past the cap: drop what is held and skip to its end.
        state.skipping = true;
        state.hash.update(buf);
        at += buf.length;
        checkpoint(state, at);
        buf = Buffer.alloc(0);
      }
      carry = Buffer.from(buf);
    }
    state.offset = at;
    state.partial = carry;
    return read;
  } finally {
    closeSync(fd);
  }
}

/** Up to `length` bytes of a regular file from `start`, or null. */
export function readRange(
  path: string,
  start: number,
  length: number
): Buffer | null {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}
