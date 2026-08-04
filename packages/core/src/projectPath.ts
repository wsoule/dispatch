import { resolve } from 'node:path';

// Normalizes a project root before it is stored or compared: resolve to an
// absolute path, then strip any trailing separator. The project registry and
// the credentials file both key on the result, so the same directory must
// always produce the same string regardless of a trailing slash.
//
// This mirrors `normalize_root` in apps/desktop/src-tauri/src/sidecar.rs (used
// there for daemon-file hashing), so the TS and Rust sides agree on a
// directory's key. Keep the two in sync.
export function normalizeProjectPath(path: string): string {
  const resolved = resolve(path);
  if (resolved === '/') return resolved;
  return resolved.endsWith('/') ? resolved.slice(0, -1) : resolved;
}
