import type {
  GuardOptions,
  LookupAll,
  PeerAuth,
  PeerRow,
  PeerSecret,
  PeerStatus,
} from '@dispatch/a2a';
import {
  AddressRefusedError,
  authHeaders,
  checkPeerCard,
  fetchPeerCard,
  guardPublicUrl,
  peerAuthFor,
  PeerClient,
  PeerHttpError,
  pickInterface,
  summarizeCard,
  UnresolvedHostError,
} from '@dispatch/a2a';
import {
  clearPeerCredential,
  readPeerCredential,
  writePeerCredential,
} from '@dispatch/core';
import type {
  Address,
  ExternalAdmission,
  ExternalTarget,
  JsonValue,
} from '@dispatch/protocol';
import {
  MessagingError,
  PEER_ALIAS_PATTERN,
  SYSTEM_ADDRESS,
} from '@dispatch/protocol';

import type { AuthTier } from '../tiers.js';
import { tierAllows } from '../tiers.js';
import type { BridgeDeps } from './port.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type PeerDeps = Pick<
  BridgeDeps,
  'rootDir' | 'engine' | 'messages' | 'store' | 'ownerRef' | 'policy' | 'now'
> & { fetchImpl?: typeof fetch; lookup?: LookupAll };

export interface PeerAddInput {
  alias: string;
  cardUrl: string;
  token?: string;
  apiKeyHeader?: string;
  allowHttp?: boolean;
  allowOrigin?: boolean;
}

export interface PeerSummary {
  alias: string;
  cardUrl: string;
  interfaceUrl: string;
  binding: 'HTTP+JSON' | 'JSONRPC';
  status: PeerStatus;
  name: string;
  description: string;
  skills: { id: string; name: string; description: string }[];
  streaming: boolean;
  addedBy: string;
  addedTier: 'decide' | 'operator';
  fetchedAt: string;
  createdAt: string;
}

export type PeerChange =
  | 'added'
  | 'enabled'
  | 'disabled'
  | 'removed'
  | 'refreshed';

export interface PeerService {
  deps: PeerDeps;
  notices: PeerNotices;
  // The routes call it after each mutation; T31's worker listens.
  emit(alias: string, what: PeerChange): void;
  onChange(listener: (alias: string, what: PeerChange) => void): () => void;
}

const nowOf = (deps: Pick<PeerDeps, 'now'>) => deps.now?.() ?? new Date();

const cardOf = (row: PeerRow): Record<string, JsonValue> =>
  JSON.parse(row.cardJson) as Record<string, JsonValue>;

// The public-address guard for a peer a deciding human added; operator-tier
// peers may name private addresses on purpose and get none.
export function peerGuard(
  deps: Pick<PeerDeps, 'lookup'>,
  row: Pick<PeerRow, 'addedTier'>
): GuardOptions | undefined {
  if (row.addedTier !== 'decide') return undefined;
  if (deps.lookup === undefined) return {};
  // Read at each resolution, so a client built earlier uses the current resolver.
  return {
    lookup: (host) =>
      (deps.lookup ?? (() => Promise.resolve([] as string[])))(host),
  };
}

function mustPeer(deps: PeerDeps, alias: string): PeerRow {
  const row = deps.store.getPeer(alias);
  if (row === null)
    throw new MessagingError('not-found', `no A2A peer ${alias}`, 'alias');
  return row;
}

// A token for a card that names no scheme is refused, never dropped unseen.
function secretFor(
  auth: PeerAuth,
  token: string | undefined
): PeerSecret | null {
  if (token === undefined || token === '') return null;
  if (auth.kind === 'none')
    throw new MessagingError(
      'invalid',
      "the peer's card asks for no credential; add it without a token",
      'token'
    );
  return auth.kind === 'bearer'
    ? { scheme: 'bearer', token }
    : { scheme: 'api-key', token, header: auth.header };
}

// One owner notice per peer, reason and day; kept in memory, so a restart may
// repeat one. Sent after the engine send that triggered it, because admission
// runs inside engine.send.
export class PeerNotices {
  private readonly sent = new Map<string, string>();
  constructor(
    private readonly deps: Pick<PeerDeps, 'engine' | 'ownerRef' | 'now'>
  ) {}

  send(alias: string, reason: string, body: string): void {
    const day = nowOf(this.deps).toISOString().slice(0, 10);
    const key = `${alias} ${reason}`;
    if (this.sent.get(key) === day) return;
    this.sent.set(key, day);
    setTimeout(() => {
      this.deps.engine
        .send(
          { to: [this.deps.ownerRef], kind: 'notice', body },
          { address: SYSTEM_ADDRESS, canDecide: true }
        )
        .catch((err: unknown) =>
          console.error('a2a: owner notice failed', err)
        );
    }, 0);
  }
}

// Tiered: the operator may name any URL and opt into http or another origin;
// a deciding human's card and interface URLs pass the public-address guard,
// and the card fetch itself is pinned to the checked address.
export async function addPeer(
  deps: PeerDeps,
  input: PeerAddInput,
  caller: { tier: AuthTier; ref: Address }
): Promise<PeerRow> {
  if (!PEER_ALIAS_PATTERN.test(input.alias))
    throw new MessagingError(
      'invalid',
      'alias: a-z, 0-9, ".", "_" and "-", at most 40',
      'alias'
    );
  if (deps.store.getPeer(input.alias) !== null)
    throw new MessagingError(
      'conflict',
      `a2a:${input.alias} exists; refresh it, or remove it first`,
      'alias'
    );
  // As with clients: an alias with history would inherit the old peer's
  // threads and context, unless a removal tombstoned that history.
  const removed = `a2a:${input.alias} was removed`;
  const history = deps.store
    .outboundOf(input.alias, ['queued', 'open', 'done', 'failed'])
    .some(
      (r) =>
        r.remoteTaskId !== null ||
        r.remoteContextId !== null ||
        r.lastError !== removed
    );
  if (history)
    throw new MessagingError(
      'conflict',
      `a2a:${input.alias} was used before; choose a new alias`,
      'alias'
    );
  const operator = tierAllows(caller.tier, 'operator');
  if (!operator && input.allowHttp === true)
    throw new MessagingError(
      'forbidden',
      '--allow-http needs the operator tier',
      'allowHttp'
    );
  if (!operator && input.allowOrigin === true)
    throw new MessagingError(
      'forbidden',
      '--allow-origin needs the operator tier',
      'allowOrigin'
    );
  const addedTier = operator ? 'operator' : 'decide';
  const guard = peerGuard(deps, { addedTier });
  if (guard !== undefined)
    await guardPublicUrl(input.cardUrl, { ...guard, field: 'cardUrl' });
  const allowHttp = operator && input.allowHttp === true;
  const allowOrigin = operator && input.allowOrigin === true;
  const fetched = await fetchPeerCard(input.cardUrl, {
    allowHttp,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(guard === undefined ? {} : { guard }),
  });
  const checked = checkPeerCard({
    cardUrl: input.cardUrl,
    card: fetched.json,
    allowOrigin,
    allowHttp,
    ...(input.apiKeyHeader === undefined
      ? {}
      : { apiKeyHeader: input.apiKeyHeader }),
  });
  if (guard !== undefined)
    await guardPublicUrl(checked.iface.url, { ...guard, field: 'cardUrl' });
  const secret = secretFor(checked.auth, input.token);
  authHeaders(checked.auth, secret);
  const at = nowOf(deps).toISOString();
  const row: PeerRow = {
    alias: input.alias,
    cardUrl: input.cardUrl,
    interfaceUrl: checked.iface.url,
    binding: checked.iface.binding,
    cardJson: JSON.stringify(fetched.json),
    etag: fetched.etag,
    fetchedAt: at,
    status: 'active',
    addedBy: caller.ref,
    addedTier,
    allowHttp,
    allowOrigin,
    apiKeyHeader: input.apiKeyHeader ?? null,
    createdAt: at,
  };
  if (secret !== null) writePeerCredential(deps.rootDir, input.alias, secret);
  deps.store.putPeer(row);
  return row;
}

export function markAuthFailed(
  deps: PeerDeps,
  notices: PeerNotices,
  alias: string
): PeerRow | null {
  const row = deps.store.getPeer(alias);
  if (row === null) return null;
  deps.store.setPeerStatus(alias, 'auth-failed');
  notices.send(
    alias,
    'auth',
    `a2a:${alias} refused Dispatch's credential. Direct messages to it fail and channels skip it until it is enabled again with a working credential, in Settings → A2A → Peers or with dispatch a2a peers enable ${alias}.`
  );
  return { ...row, status: 'auth-failed' };
}

// Disables a peer and tells the owner once a day for this reason.
export function disablePeer(
  deps: PeerDeps,
  notices: PeerNotices,
  alias: string,
  reason: string,
  body: string
): PeerRow | null {
  const row = deps.store.getPeer(alias);
  if (row === null) return null;
  deps.store.setPeerStatus(alias, 'disabled');
  notices.send(alias, reason, body);
  return { ...row, status: 'disabled' };
}

// The notice a decide-tier peer gets when its name stops resolving publicly.
function addressRefused(alias: string, why: string): string {
  return `a2a:${alias} is disabled: ${why}. A peer added below the operator tier must resolve only to public addresses. Check it, then enable it in Settings → A2A → Peers or with dispatch a2a peers enable ${alias}.`;
}

// Why the guard refuses `url` now, or null when it passes (or there is no
// guard). A name that does not resolve is a network failure, never a refusal:
// it throws PeerHttpError(null), so the refresh is skipped and the peer kept.
async function refusedUrl(
  guard: GuardOptions | undefined,
  url: string
): Promise<string | null> {
  if (guard === undefined) return null;
  try {
    await guardPublicUrl(url, { ...guard, field: 'cardUrl' });
    return null;
  } catch (err) {
    if (err instanceof UnresolvedHostError)
      throw new PeerHttpError(null, err.message);
    if (err instanceof MessagingError) return err.message;
    throw err;
  }
}

// Re-fetches under the rules the peer was added with: a moved interface origin
// disables it (keeping the old address), 401/403 marks it auth-failed, and a
// decide-tier peer that resolves privately is disabled.
export async function refreshPeer(
  deps: PeerDeps,
  notices: PeerNotices,
  alias: string
): Promise<PeerRow> {
  const row = mustPeer(deps, alias);
  const guard = peerGuard(deps, row);
  const refused = await refusedUrl(guard, row.cardUrl);
  if (refused !== null)
    return (
      disablePeer(
        deps,
        notices,
        alias,
        'address',
        addressRefused(alias, refused)
      ) ?? row
    );
  let fetched;
  try {
    fetched = await fetchPeerCard(row.cardUrl, {
      allowHttp: row.allowHttp,
      etag: row.etag,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      ...(guard === undefined ? {} : { guard }),
    });
  } catch (err) {
    if (
      err instanceof PeerHttpError &&
      (err.status === 401 || err.status === 403)
    )
      return markAuthFailed(deps, notices, alias) ?? row;
    // The pinned fetch refused the address after the pre-check passed (a rebind).
    if (err instanceof AddressRefusedError)
      return (
        disablePeer(
          deps,
          notices,
          alias,
          'address',
          addressRefused(alias, err.message)
        ) ?? row
      );
    throw err;
  }
  const at = nowOf(deps).toISOString();
  if (fetched.notModified) {
    const next = { ...row, fetchedAt: at };
    deps.store.putPeer(next);
    return next;
  }
  const iface = pickInterface(fetched.json);
  const oldOrigin = new URL(row.interfaceUrl).origin;
  let newOrigin: string | null = null;
  try {
    newOrigin = iface === null ? null : new URL(iface.url).origin;
  } catch {
    newOrigin = null;
  }
  if (iface !== null && newOrigin !== oldOrigin) {
    const next: PeerRow = { ...row, fetchedAt: at, status: 'disabled' };
    deps.store.putPeer(next);
    notices.send(
      alias,
      'origin',
      `a2a:${alias}'s card now points at ${newOrigin ?? iface.url} instead of ${oldOrigin}. The peer is disabled; remove it and add it again to accept the new address.`
    );
    return next;
  }
  const checked = checkPeerCard({
    cardUrl: row.cardUrl,
    card: fetched.json,
    allowOrigin: row.allowOrigin,
    allowHttp: row.allowHttp,
    ...(row.apiKeyHeader === null ? {} : { apiKeyHeader: row.apiKeyHeader }),
  });
  const ifaceRefused = await refusedUrl(guard, checked.iface.url);
  if (ifaceRefused !== null)
    return (
      disablePeer(
        deps,
        notices,
        alias,
        'address',
        addressRefused(alias, ifaceRefused)
      ) ?? row
    );
  const next: PeerRow = {
    ...row,
    interfaceUrl: checked.iface.url,
    binding: checked.iface.binding,
    cardJson: JSON.stringify(fetched.json),
    etag: fetched.etag,
    fetchedAt: at,
  };
  deps.store.putPeer(next);
  return next;
}

// The 24 h card refresh; the bridge runs it hourly.
export async function refreshDuePeers(
  deps: PeerDeps,
  notices: PeerNotices
): Promise<number> {
  const cutoff = nowOf(deps).getTime() - DAY_MS;
  let refreshed = 0;
  for (const row of deps.store.peers()) {
    if (row.status === 'disabled' || Date.parse(row.fetchedAt) > cutoff)
      continue;
    try {
      await refreshPeer(deps, notices, row.alias);
      refreshed += 1;
    } catch (err) {
      console.error(`a2a: refreshing a2a:${row.alias} failed`, err);
    }
  }
  return refreshed;
}

// A token replaces the credential. Enabling a decide-tier peer re-checks its
// card and interface URLs against the public-address rules first.
export async function setPeerEnabled(
  deps: PeerDeps,
  alias: string,
  enabled: boolean,
  token?: string
): Promise<PeerRow> {
  const row = mustPeer(deps, alias);
  const guard = peerGuard(deps, row);
  if (enabled && guard !== undefined) {
    await guardPublicUrl(row.cardUrl, { ...guard, field: 'cardUrl' });
    await guardPublicUrl(row.interfaceUrl, { ...guard, field: 'cardUrl' });
  }
  if (token !== undefined && token !== '') {
    const auth = peerAuthFor(cardOf(row), row.apiKeyHeader ?? undefined);
    const secret = secretFor(auth, token);
    authHeaders(auth, secret);
    if (secret !== null) writePeerCredential(deps.rootDir, alias, secret);
  }
  const status: PeerStatus = enabled ? 'active' : 'disabled';
  deps.store.setPeerStatus(alias, status);
  return { ...row, status };
}

export function removePeer(deps: PeerDeps, alias: string): boolean {
  // The secret goes first: a credentials file that refuses the clear leaves
  // the peer listed, never a row gone with its token still stored.
  clearPeerCredential(deps.rootDir, alias);
  return deps.store.deletePeer(alias);
}

// The peer notices plus a listener set: routes emit each change, and the
// outbound worker listens to stop, fail or resume a peer's traffic.
export function createPeerService(deps: PeerDeps): PeerService {
  const listeners = new Set<(alias: string, what: PeerChange) => void>();
  return {
    deps,
    notices: new PeerNotices(deps),
    emit: (alias, what) => {
      for (const listener of listeners) {
        try {
          listener(alias, what);
        } catch (err) {
          console.error(`a2a: a peer listener failed on ${what}`, err);
        }
      }
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** What the API shows of a peer: never its credential. */
export function peerSummary(row: PeerRow): PeerSummary {
  const summary = summarizeCard(cardOf(row));
  return {
    alias: row.alias,
    cardUrl: row.cardUrl,
    interfaceUrl: row.interfaceUrl,
    binding: row.binding,
    status: row.status,
    ...summary,
    addedBy: row.addedBy,
    addedTier: row.addedTier,
    fetchedAt: row.fetchedAt,
    createdAt: row.createdAt,
  };
}

// The client for one peer, with its stored credential and, for a decide-tier
// peer, the guard every request re-applies. Throws MessagingError 'token'
// when the card needs a credential that is not stored.
export function peerClientFor(deps: PeerDeps, row: PeerRow): PeerClient {
  const card = cardOf(row);
  const headers = authHeaders(
    peerAuthFor(card, row.apiKeyHeader ?? undefined),
    readPeerCredential(deps.rootDir, row.alias)
  );
  const guard = peerGuard(deps, row);
  return new PeerClient({
    iface: { url: row.interfaceUrl, binding: row.binding },
    card,
    headers,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(guard === undefined ? {} : { guard }),
  });
}

// The engine's admission for a2a: targets. Direct to an absent or inactive
// peer fails; a channel member is skipped (one owner notice a day). Direct over
// outboundPerHour fails; a channel delivery is admitted and held.
export function admitPeer(
  deps: Pick<PeerDeps, 'store' | 'messages' | 'policy' | 'now'>,
  notices: PeerNotices,
  target: ExternalTarget
): ExternalAdmission {
  const alias = target.recipient.slice('a2a:'.length);
  const row = deps.store.getPeer(alias);
  if (row === null || row.status !== 'active') {
    if (target.via === 'channel') {
      notices.send(
        alias,
        'inactive',
        `a2a:${alias} is ${row?.status ?? 'not registered'}; channel messages to it are skipped.`
      );
      return 'skip';
    }
    throw new MessagingError(
      'not-found',
      `no active A2A peer ${alias}`,
      target.field
    );
  }
  if (target.via === 'direct') {
    const limit = deps.policy().outboundPerHour;
    const hourAgo = new Date(nowOf(deps).getTime() - HOUR_MS).toISOString();
    if (deps.messages.countDeliveredTo(target.recipient, hourAgo) >= limit) {
      throw new MessagingError(
        'limited',
        `a2a:${alias} takes at most ${limit} messages an hour`,
        target.field
      );
    }
  }
  return 'deliver';
}
