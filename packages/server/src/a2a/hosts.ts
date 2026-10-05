import type { A2AStore, HostRow } from '@dispatch-foo/a2a';
import { isLoopbackHost } from '@dispatch-foo/a2a';
import type { Address } from '@dispatch-foo/protocol';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { tokenHash } from './auth.js';

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** A host name as an operator types it: one short line of plain characters. */
export function isHostName(name: string): boolean {
  return NAME.test(name);
}

// The public URL a host serves on: https, or http on loopback, with no
// credentials or query; null when it is anything else.
export function hostPublicUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    const plainOk = url.protocol === 'http:' && isLoopbackHost(url.hostname);
    if (url.protocol !== 'https:' && !plainOk) return null;
    if (url.username !== '' || url.password !== '' || url.search !== '')
      return null;
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

// An operator-issued credential for one standalone host (spec:1676-1685):
// 256 random bits, shown once, kept only as sha256 in the 0600 a2a.db.
export function mintHost(
  store: A2AStore,
  name: string,
  publicUrl: string,
  createdBy: Address,
  now = new Date()
): { row: HostRow; token: string } {
  const token = randomBytes(32).toString('hex');
  const row: HostRow = {
    id: `h-${randomUUID().slice(0, 8)}`,
    name,
    tokenHash: tokenHash(token),
    publicUrl,
    createdBy,
    createdAt: now.toISOString(),
    revokedAt: null,
  };
  store.putHost(row);
  return { row, token };
}

// The live host a presented token belongs to, or null. The lookup is by hash,
// and the stored hash is compared again in constant time.
export function authenticateHost(
  store: A2AStore | null,
  presented: string | null
): HostRow | null {
  if (store === null || presented === null || presented === '') return null;
  const hash = tokenHash(presented);
  const row = store.hostByTokenHash(hash);
  if (row === null || row.revokedAt !== null) return null;
  const a = Buffer.from(row.tokenHash, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b) ? row : null;
}
