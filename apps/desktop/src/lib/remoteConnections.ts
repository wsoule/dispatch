import type { AuthTier, PairedCredential } from '@dispatch/client';
import {
  normalizeDaemonUrl,
  redeemPairingCode,
  remoteUrlProblem,
} from '@dispatch/client';

import type { DaemonConnection } from './daemonAuth';

// Daemons on other machines this app has paired with (`dispatch pair` on
// that machine; see packages/server/src/devices.ts).
//
// The app is keyed on a project root everywhere — the switcher, the nav
// state, the connection query — so a remote daemon gets a root of its own,
// `dispatch-remote://<id>`, that nothing mistakes for a path on this disk.
// Its own module, not part of tauri.ts, for the reason teamLocal.ts gives:
// test files mock tauri.ts with only the exports they need.
//
// Each saved connection carries its device token. It lives in this app's own
// storage, which only this user can read — the same standing as the 0600
// daemon files the CLI reads its token from.

const REMOTE_ROOT_PREFIX = 'dispatch-remote://';

const STORAGE_KEY = 'dispatch:remote-connections';

/** A daemon on another machine, and the device token this app holds for it. */
export interface RemoteConnection {
  id: string;
  /** What the switcher shows: the remote project's folder name. */
  name: string;
  /** The daemon's origin: https, or http to loopback (an SSH forward). */
  baseUrl: string;
  token: string;
  tier: AuthTier;
  /** The operator this device speaks for on that daemon. */
  handle: string;
  /** This device's id there, for unpairing it. */
  deviceId: string;
  /** The project's root on the remote machine, for display. */
  remoteRoot: string;
  addedAt: string;
}

export function isRemoteRoot(root: string | null | undefined): boolean {
  return typeof root === 'string' && root.startsWith(REMOTE_ROOT_PREFIX);
}

export function remoteRootFor(id: string): string {
  return `${REMOTE_ROOT_PREFIX}${id}`;
}

function isRemoteConnection(value: unknown): value is RemoteConnection {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    typeof c.name === 'string' &&
    typeof c.baseUrl === 'string' &&
    // A hand-edited entry pointing a token at plain http elsewhere is
    // dropped rather than used.
    remoteUrlProblem(c.baseUrl) === null &&
    typeof c.token === 'string' &&
    (c.tier === 'request' || c.tier === 'decide' || c.tier === 'operator') &&
    typeof c.handle === 'string' &&
    typeof c.deviceId === 'string' &&
    typeof c.remoteRoot === 'string' &&
    typeof c.addedAt === 'string'
  );
}

/** Every saved remote. Unreadable storage reads as none. */
export function listRemoteConnections(
  storage: Storage = window.localStorage
): RemoteConnection[] {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter(isRemoteConnection) : [];
  } catch {
    return [];
  }
}

function writeAll(storage: Storage, all: RemoteConnection[]): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(all));
}

/** The saved remote a root names, or null. */
export function remoteConnectionFor(
  root: string,
  storage: Storage = window.localStorage
): RemoteConnection | null {
  if (!isRemoteRoot(root)) return null;
  const id = root.slice(REMOTE_ROOT_PREFIX.length);
  return listRemoteConnections(storage).find((c) => c.id === id) ?? null;
}

/** Forgets a saved remote. Does not unpair it on the daemon. */
export function forgetRemoteConnection(
  id: string,
  storage: Storage = window.localStorage
): void {
  writeAll(
    storage,
    listRemoteConnections(storage).filter((c) => c.id !== id)
  );
}

/**
 * A stable stand-in for `DaemonConnection.port`. The app keys every query
 * cache on the port, and a remote has none of its own; a negative number
 * derived from the id never collides with a real port or another remote.
 */
export function remoteCacheKey(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (Math.imul(hash, 31) + id.charCodeAt(i)) | 0;
  }
  return -(Math.abs(hash) + 1);
}

/** What `ensureDispatchd` hands back for a remote root. */
export function remoteDaemonConnection(
  connection: RemoteConnection
): DaemonConnection {
  return {
    port: remoteCacheKey(connection.id),
    appToken: null,
    agentToken: null,
    baseUrl: connection.baseUrl,
    remote: { token: connection.token, tier: connection.tier },
  };
}

export interface PairRemoteInput {
  url: string;
  code: string;
  /** What the daemon lists this device as. */
  deviceName: string;
}

/** The two network calls pairing makes, injectable for tests. */
export interface PairRemoteDeps {
  redeem?: (
    baseUrl: string,
    code: string,
    name: string
  ) => Promise<PairedCredential>;
  /** The remote project's root, read with the new token. */
  projectRoot?: (baseUrl: string, token: string) => Promise<string>;
  storage?: Storage;
  now?: () => Date;
}

async function fetchProjectRoot(
  baseUrl: string,
  token: string
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/health`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as { rootDir?: unknown };
  return typeof body.rootDir === 'string' ? body.rootDir : '';
}

function folderName(path: string, fallback: string): string {
  const segment = path.replace(/\/+$/, '').split('/').pop() ?? '';
  return segment === '' ? fallback : segment;
}

/**
 * Pairs this app with the daemon at `url` and saves the connection; resolves
 * to the root to switch the window to. Refuses, before anything is sent, a
 * URL that would carry the token over plain http to another machine. Pairing
 * the same daemon again replaces the saved entry rather than adding a second.
 */
export async function pairRemote(
  input: PairRemoteInput,
  deps: PairRemoteDeps = {}
): Promise<string> {
  const problem = remoteUrlProblem(input.url);
  if (problem !== null) throw new Error(problem);
  const baseUrl = normalizeDaemonUrl(input.url);
  const code = input.code.trim();
  if (code === '') throw new Error('enter the code `dispatch pair` printed');
  const storage = deps.storage ?? window.localStorage;
  const paired = await (deps.redeem ?? redeemPairingCode)(
    baseUrl,
    code,
    input.deviceName
  );
  const remoteRoot = await (deps.projectRoot ?? fetchProjectRoot)(
    baseUrl,
    paired.token
  ).catch(() => '');
  const connection: RemoteConnection = {
    id: paired.device.id,
    name: folderName(remoteRoot, new URL(baseUrl).hostname),
    baseUrl,
    token: paired.token,
    tier: paired.tier,
    handle: paired.handle,
    deviceId: paired.device.id,
    remoteRoot,
    addedAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  writeAll(storage, [
    ...listRemoteConnections(storage).filter((c) => c.baseUrl !== baseUrl),
    connection,
  ]);
  return remoteRootFor(connection.id);
}
