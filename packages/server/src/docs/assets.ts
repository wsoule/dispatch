import { ASSET_NAME } from '@dispatch-foo/core';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import { DocsError } from './errors.js';

// Images in docs: typed by their magic bytes, never by what a request claims;
// SVG is refused because it can carry script (D43). Files live under
// docs-assets/<doc id>/<sha256>.<ext>, reached only through checked parts.

type ImageKind =
  | { mime: 'image/png'; ext: 'png' }
  | { mime: 'image/jpeg'; ext: 'jpg' }
  | { mime: 'image/gif'; ext: 'gif' }
  | { mime: 'image/webp'; ext: 'webp' };

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

// Doc ids are `doc-` and a ULID; checked again before one names a directory.
const DOC_ID = /^doc-[0-9A-Z]{26}$/;

function startsWith(b: Uint8Array, sig: readonly number[], at = 0): boolean {
  return b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
}

/** The image type `b`'s magic bytes name; null for SVG and everything else. */
export function sniffImage(b: Uint8Array): ImageKind | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { mime: 'image/png', ext: 'png' };
  if (startsWith(b, [0xff, 0xd8, 0xff]))
    return { mime: 'image/jpeg', ext: 'jpg' };
  if (
    startsWith(b, [0x47, 0x49, 0x46, 0x38]) &&
    (b[4] === 0x37 || b[4] === 0x39) &&
    b[5] === 0x61
  )
    return { mime: 'image/gif', ext: 'gif' };
  if (
    startsWith(b, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)
  )
    return { mime: 'image/webp', ext: 'webp' };
  return null;
}

const symlinkError = (what: string): DocsError =>
  new DocsError('invalid', `${what} is a symlink or not where it belongs`);

// The real directory at `path`: refused when it is a symlink or anything else.
function realDir(path: string, what: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) throw symlinkError(what);
}

// A directory created 0700 if missing, then checked to be a real directory
// inside `parent` (which must itself be real).
function ensureDir(parent: string, path: string, what: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  realDir(path, what);
  const inside = relative(realpathSync(parent), realpathSync(path));
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside))
    throw symlinkError(what);
}

function checkParts(docId: string, name: string): void {
  if (!DOC_ID.test(docId))
    throw new DocsError('invalid', 'not a doc id', 'doc');
  if (!ASSET_NAME.test(name))
    throw new DocsError('invalid', 'not an asset name', 'name');
}

/** Writes `bytes` as `root/<docId>/<name>` (0600 in 0700 directories), through
 *  an exclusive temp file and a rename; no component may be a symlink. */
export function storeAssetFile(
  root: string,
  docId: string,
  name: string,
  bytes: Uint8Array
): void {
  checkParts(docId, name);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  realDir(root, 'docs-assets');
  const dir = join(root, docId);
  ensureDir(root, dir, `docs-assets/${docId}`);
  const target = join(dir, name);
  try {
    const st = lstatSync(target);
    if (!st.isFile()) throw symlinkError(`docs-assets/${docId}/${name}`);
    // Content-addressed: a file whose bytes still match its name is kept; a
    // damaged one is written again below.
    if (st.nlink === 1) {
      // Throws, and so falls through to the rewrite, when the bytes differ.
      readAssetFile(root, docId, name);
      return;
    }
  } catch (err) {
    // Missing, damaged, linked elsewhere or a symlink: replaced below, since a
    // rename swaps the directory entry and never writes through it.
    if (
      !(err instanceof DocsError) &&
      (err as NodeJS.ErrnoException).code !== 'ENOENT'
    )
      throw err;
  }
  const temp = join(dir, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    renameSync(temp, target);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** The path of a stored asset after checking every component is real and
 *  inside `root`; not-found when the file is missing. */
export function assetFilePath(
  root: string,
  docId: string,
  name: string
): string {
  checkParts(docId, name);
  const dir = join(root, docId);
  const path = join(dir, name);
  try {
    realDir(root, 'docs-assets');
    realDir(dir, `docs-assets/${docId}`);
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile())
      throw symlinkError(`docs-assets/${docId}/${name}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      throw new DocsError('not-found', `asset ${name} not found`, 'name');
    throw err;
  }
  const inside = relative(realpathSync(root), realpathSync(path));
  if (inside.startsWith('..') || isAbsolute(inside))
    throw symlinkError(`docs-assets/${docId}/${name}`);
  return path;
}

const hashOf = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** A stored asset's bytes, read without following a symlink (O_NOFOLLOW),
 *  only from a regular file no other hard link reaches, and only when their
 *  sha256 is the one its name records. */
export function readAssetFile(
  root: string,
  docId: string,
  name: string
): Uint8Array {
  const path = assetFilePath(root, docId, name);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP')
      throw symlinkError(`docs-assets/${docId}/${name}`);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1)
      throw new DocsError(
        'invalid',
        `docs-assets/${docId}/${name} is not a single-link regular file`
      );
    const bytes = new Uint8Array(readFileSync(fd));
    if (hashOf(bytes) !== name.slice(0, 64))
      throw new DocsError(
        'invalid',
        `docs-assets/${docId}/${name} does not match its name`
      );
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** Removes a deleted doc's asset directory; a symlink there is unlinked, never followed. */
export function removeAssetDir(root: string, docId: string): void {
  if (!DOC_ID.test(docId)) return;
  rmSync(join(root, docId), { recursive: true, force: true });
}
