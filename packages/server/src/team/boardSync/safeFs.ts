import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
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
