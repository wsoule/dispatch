import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { normalizeProjectPath } from './projectPath.js';

/** One project's secrets, one key per integration. */
export interface ProjectCredentials {
  linear?: { apiKey: string };
}

/** User-level secrets. Never written to a project's `.dispatch/`. */
export interface CredentialsFile {
  /** Machine-wide default, kept as a read-only fallback. Nothing writes it any more. */
  linear?: { apiKey: string };
  /** Per-project secrets, keyed by `normalizeProjectPath` of the project root. */
  projects?: Record<string, ProjectCredentials>;
}

// The integration name space, e.g. `'linear'` — not `keyof CredentialsFile`,
// which would also admit `'projects'`.
export type CredentialName = keyof ProjectCredentials;

// Same `DISPATCH_HOME`-or-homedir rule as registry.ts and daemonfile.ts; an
// empty string counts as unset.
function credentialsHome(): string {
  const home = process.env.DISPATCH_HOME;
  return home !== undefined && home !== '' ? home : homedir();
}

export function credentialsPath(): string {
  return resolve(credentialsHome(), '.dispatch', 'credentials.json');
}

// A missing or corrupt file reads as "no credentials stored" rather than throwing,
// so a damaged file degrades to "not connected" instead of breaking every read.
export function readCredentials(): CredentialsFile {
  const path = credentialsPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    return parsed as CredentialsFile;
  } catch {
    return {};
  }
}

// Writes with mode 0600 on both the create and the overwrite path — writeFileSync's
// `mode` is ignored when the file already exists, so the chmod is explicit.
function writeCredentials(file: CredentialsFile): void {
  const path = credentialsPath();
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // A filesystem without POSIX modes is not a reason to fail the write.
  }
}

export function writeCredential(
  name: CredentialName,
  value: { apiKey: string }
): void {
  writeCredentials({ ...readCredentials(), [name]: value });
}

export function clearCredential(name: CredentialName): void {
  const file = readCredentials();
  delete file[name];
  writeCredentials(file);
}

// Stores a secret against one project root. The global `linear` slot is left
// alone, so an existing machine-wide key keeps working for every other project.
export function writeProjectCredential(
  rootDir: string,
  name: CredentialName,
  value: { apiKey: string }
): void {
  const file = readCredentials();
  const key = normalizeProjectPath(rootDir);
  const existing = file.projects?.[key] ?? {};
  writeCredentials({
    ...file,
    projects: { ...file.projects, [key]: { ...existing, [name]: value } },
  });
}

// Removes one secret from one project, dropping the project's entry once its
// last secret is gone so the file does not accumulate empty objects.
export function clearProjectCredential(
  rootDir: string,
  name: CredentialName
): void {
  const file = readCredentials();
  const key = normalizeProjectPath(rootDir);
  const entry = file.projects?.[key];
  if (entry === undefined) return;

  const remaining: ProjectCredentials = { ...entry };
  delete remaining[name];

  const projects = { ...file.projects };
  if (Object.keys(remaining).length === 0) delete projects[key];
  else projects[key] = remaining;

  const next: CredentialsFile = { ...file, projects };
  if (Object.keys(projects).length === 0) delete next.projects;
  writeCredentials(next);
}

/** Where a resolved key came from — in precedence order — or `null` when there is none. */
export type CredentialSource = 'project' | 'env' | 'global' | null;

// A stored or exported value only counts when it has content after trimming, so
// a blank env var falls through to the next tier instead of masking it.
function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// The project's own key wins, so a stale `LINEAR_API_KEY` in the shell cannot
// hijack a project that was deliberately connected. The env var is next, and the
// legacy machine-wide key is the last resort.
export function resolveLinearApiKey(rootDir: string): {
  apiKey: string | null;
  source: CredentialSource;
} {
  const file = readCredentials();

  const fromProject = nonEmpty(
    file.projects?.[normalizeProjectPath(rootDir)]?.linear?.apiKey
  );
  if (fromProject !== null) return { apiKey: fromProject, source: 'project' };

  const fromEnv = nonEmpty(process.env.LINEAR_API_KEY);
  if (fromEnv !== null) return { apiKey: fromEnv, source: 'env' };

  const fromGlobal = nonEmpty(file.linear?.apiKey);
  if (fromGlobal !== null) return { apiKey: fromGlobal, source: 'global' };

  return { apiKey: null, source: null };
}
