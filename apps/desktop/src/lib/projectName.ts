/** Derives the sidebar's project display name from the active project's absolute filesystem
 * root — e.g. `/Users/wyat/Sites/dispatch` becomes `dispatch`. A plain string split rather
 * than Node's `path.basename` (not available in the renderer) since `currentProjectRoot()`
 * already hands back a POSIX-style absolute path from the Rust backend. Falls back to the
 * original `path` for anything with no usable last segment (`/`, `''`) rather than returning
 * an empty string the sidebar would render as a blank row. */
export function basename(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const lastSlash = trimmed.lastIndexOf('/');
  const segment = lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
  return segment === '' ? path : segment;
}

/** The folder that contains `path` — e.g. `/Users/wyat/Sites/dispatch` becomes
 * `/Users/wyat/Sites`. The Add project picker starts here so it opens beside the current
 * project instead of inside it. Accepts `/` and `\` separators since Windows roots come back
 * with backslashes. Returns `null` when there is no parent to offer (a bare name, `/`, `C:\`),
 * so the caller can fall back to the home folder. */
export function parentDir(path: string): string | null {
  const trimmed = path.replace(/[/\\]+$/, '');
  const lastSep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (lastSep === -1) return null;
  const parent = trimmed.slice(0, lastSep);
  // `/Users` → `/`, and `C:\Users` → `C:\`: keep the root's own separator.
  if (parent === '' || /^[A-Za-z]:$/.test(parent)) {
    return parent + trimmed[lastSep];
  }
  return parent;
}
