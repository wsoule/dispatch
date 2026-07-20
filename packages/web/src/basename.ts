// Basename of a filesystem path, without pulling in node:path (this runs in
// the browser) — good enough for the project name shown in the top bar.
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}
