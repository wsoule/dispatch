/** Derives the sidebar's project display name from the active project's absolute filesystem
 * root — e.g. `/Users/wyat/Sites/Linear-2` becomes `Linear-2`. A plain string split rather
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
