import { resolve } from 'node:path';

// Normalizes a project root before it is stored or compared: resolve to an
// absolute path, then strip any trailing separator. The project registry and
// the credentials file both key on the result, so the same directory must
// always produce the same string regardless of a trailing slash.
//
// This mirrors `normalize_root` in apps/desktop/src-tauri/src/sidecar.rs for
// absolute paths only (the Rust side rejects a relative one instead of
// resolving it against cwd) — keep the two in sync on that shared ground.
export function normalizeProjectPath(path: string): string {
  const resolved = resolve(path);
  if (resolved === '/') return resolved;
  return resolved.endsWith('/') ? resolved.slice(0, -1) : resolved;
}
