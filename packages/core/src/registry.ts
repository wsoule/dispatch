import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';

// A project the CLI (and, per Task 8, the desktop app's Rust side) knows
// about — enough to show it in a project switcher and re-open it without the
// user retyping a path. One entry per distinct project root; `path` is
// always the normalized absolute path (see `normalizeRegistryPath` below).
export interface RegisteredProject {
  path: string;
  name: string;
  addedAt: string;
  lastOpenedAt: string;
}

interface RegistryFile {
  projects: RegisteredProject[];
}

// `DISPATCH_HOME` lets tests (and anything else) redirect the registry away
// from the real home directory; production use always falls back to it. An
// empty string is treated the same as unset — this is the same scheme
// documented at length in packages/server/src/daemonfile.ts's `daemonHome()`
// (and its four other copies); the registry is a sixth copy of the exact
// same env-var-and-fallback rule, so keep it in sync if that scheme changes.
function registryHome(): string {
  const home = process.env.DISPATCH_HOME;
  return home !== undefined && home !== '' ? home : homedir();
}

// Path to `~/.dispatch/projects.json` (or `$DISPATCH_HOME/.dispatch/
// projects.json`). Task 8's Rust side reads/writes this exact same file, so
// its on-disk shape (a `{ projects: [...] }` object, not a bare array) and
// this path must stay stable.
export function registryPath(): string {
  return resolve(registryHome(), '.dispatch', 'projects.json');
}

// Normalizes a project path before it's stored or compared: resolve to an
// absolute path, then strip any trailing separator. This mirrors
// `normalize_root` in apps/desktop/src-tauri/src/sidecar.rs (used there for
// daemon-file hashing) so the same directory always produces the same
// registry key regardless of which side — TS or Rust — wrote it, and
// regardless of a trailing slash on the input.
function normalizeRegistryPath(path: string): string {
  const resolved = resolve(path);
  if (resolved === '/') return resolved;
  return resolved.endsWith('/') ? resolved.slice(0, -1) : resolved;
}

// Reads the registry, treating a missing or corrupt file as an empty list
// rather than throwing — a brand-new machine (no registry yet) and a
// registry damaged by e.g. a crash mid-write should both behave like "no
// projects registered yet", not crash the CLI.
export function readRegistry(): RegisteredProject[] {
  const path = registryPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as RegistryFile;
    return Array.isArray(parsed.projects) ? parsed.projects : [];
  } catch {
    return [];
  }
}

function writeRegistry(projects: RegisteredProject[]): void {
  const path = registryPath();
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ projects }, null, 2)}\n`);
}

// Adds a project to the registry, or refreshes it if already present.
// Dedupes on the normalized path (so `/a/b` and `/a/b/` are the same
// project); a fresh registration stamps both `addedAt` and `lastOpenedAt`,
// while re-registering an existing project only bumps `lastOpenedAt` —
// `addedAt` is when it was first seen, not when it was last opened.
export function upsertRegisteredProject(path: string): RegisteredProject {
  const normalized = normalizeRegistryPath(path);
  const now = new Date().toISOString();
  const projects = readRegistry();
  const existing = projects.find((p) => p.path === normalized);

  const entry: RegisteredProject =
    existing !== undefined
      ? { ...existing, lastOpenedAt: now }
      : {
          path: normalized,
          name: basename(normalized),
          addedAt: now,
          lastOpenedAt: now,
        };

  const next =
    existing !== undefined
      ? projects.map((p) => (p.path === normalized ? entry : p))
      : [...projects, entry];

  writeRegistry(next);
  return entry;
}
