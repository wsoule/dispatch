import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/**
 * Maps a request path to a file inside root, or null if it points anywhere else.
 *
 * This started as `new URL(pathname, publicDir)`, which is wrong in a way worth recording: that
 * constructor resolves URLs, it does not join paths, so a request for `/file:///etc/hosts`
 * carries its own scheme, the base is discarded, and the server hands out an arbitrary file. The
 * `..` case people reach for first was never the hole — the URL parser normalises double-dot
 * segments, including their percent-encoded spellings, before they reach here.
 *
 * So containment is asserted rather than assumed: decode to a plain string, resolve it, and
 * require the result to still sit under root. That does not depend on knowing every parser quirk.
 */
function resolveInRoot(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;
  const full = resolve(root, `.${decoded}`);
  return full.startsWith(root) || `${full}${sep}` === root ? full : null;
}

// The file a request path serves: the file itself, or a directory's
// index.html (Bun.file(dir).exists() is false for a directory).
export async function fileFor(
  root: string,
  pathname: string
): Promise<string | null> {
  const path = resolveInRoot(root, pathname);
  if (path === null) return null;
  const info = await stat(path).catch(() => null);
  if (info === null) return null;
  if (info.isFile()) return path;
  if (!info.isDirectory()) return null;
  const index = resolve(path, 'index.html');
  const indexInfo = await stat(index).catch(() => null);
  return indexInfo !== null && indexInfo.isFile() ? index : null;
}
