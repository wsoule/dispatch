import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** User-level secrets, one key per integration. Never written to a project's `.dispatch/`. */
export interface CredentialsFile {
  linear?: { apiKey: string };
}

export type CredentialName = keyof CredentialsFile;

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

/** Where a resolved key came from — `env` wins over the stored file, `null` means none. */
export type CredentialSource = 'env' | 'file' | null;

// The environment takes precedence over the stored file, so a shell or CI export
// overrides whatever the app saved.
export function resolveLinearApiKey(): {
  apiKey: string | null;
  source: CredentialSource;
} {
  const fromEnv = process.env.LINEAR_API_KEY;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return { apiKey: fromEnv.trim(), source: 'env' };
  }
  const stored = readCredentials().linear?.apiKey;
  if (typeof stored === 'string' && stored.trim() !== '') {
    return { apiKey: stored.trim(), source: 'file' };
  }
  return { apiKey: null, source: null };
}
