import {
  a2aFingerprint,
  checkProof,
  decodePairingCode,
  ecThumbprint,
  encodePairingCode,
  makeProof,
  newPairingCode,
  pairingPin,
  parseUnpairNotice,
  peerFetch,
  PeerHttpError,
  sas,
  signedFetch,
  signResponseFor,
  unpairNotice,
  verifyCardSignature,
} from '@dispatch-foo/a2a';
import type {
  AuthResult,
  KeyPin,
  PairingRow,
  PeerRow,
  Reach,
  RequestParts,
} from '@dispatch-foo/a2a';
import type { Address } from '@dispatch-foo/protocol';
import { MessagingError, PEER_ALIAS_PATTERN } from '@dispatch-foo/protocol';
import { createPublicKey, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { basename } from 'node:path';

import type { AuthTier } from '../tiers.js';
import { tierAllows } from '../tiers.js';
import { tokenHash } from './auth.js';
import type { PeerChange, PeerDeps, PeerNotices } from './peers.js';
import { checkNewPeer, peerGuard, removePeer } from './peers.js';
import { NoticeRetries } from './retry.js';

// Symmetric pairing in the daemon (P5): offering a code, accepting one, and
// completing an offer when the accepter's proof arrives on the listener.

export interface PairingDeps extends PeerDeps {
  notices: PeerNotices;
  emit: (alias: string, what: PeerChange) => void;
  // The tier `ref` acts at now: the owner's, a live teammate's issued tier,
  // or null once revoked. Absent, every creator stands (fixtures).
  creatorTier?: (ref: Address) => AuthTier | null;
}

interface Caller {
  tier: AuthTier;
  ref: Address;
}

const TTL_MIN = { min: 5, max: 60, default: 15 };
const MAX_PROOF_BYTES = 64 * 1024;
const PAIR_PATH = '/dispatch/pair';
const UNPAIR_PATH = '/dispatch/unpair';

const now = (d: PairingDeps): Date => d.now?.() ?? new Date();

// A fetch that signs with our card key (or `key`) and accepts only replies
// signed by `peerJwk`, under the guard at the peer's recorded tier.
export function pairedFetch(
  d: PairingDeps,
  peer: Pick<PeerRow, 'addedTier'>,
  peerJwk: Record<string, string>,
  key: { keyid: string; privateKey: KeyObject } = ourKey(d)
): typeof fetch {
  const guard = peerGuard(d, peer);
  return signedFetch(
    peerFetch({
      headers: {},
      fetchImpl: d.fetchImpl,
      timeoutMs: 30_000,
      guard: guard === undefined ? undefined : { field: 'url', ...guard },
    }),
    {
      keyid: key.keyid,
      privateKey: key.privateKey,
      peerKey: createPublicKey({ key: peerJwk, format: 'jwk' }),
    }
  );
}

// This project's card key; pairing cannot happen without one.
/** This project's card key for pairing; throws when card signing is off. */
export function ourKey(d: PairingDeps) {
  const signer = d.signer?.() ?? null;
  if (signer === null)
    throw new MessagingError(
      'conflict',
      "card signing is off; pairing needs this project's card key"
    );
  const key = signer.requestKey();
  return { ...key, jwk: signer.publicJwk() };
}

/** The name this side shows the other in a pairing. */
export function ourName(d: PairingDeps): string {
  return (d.policy().name ?? basename(d.rootDir)).slice(0, 100);
}

function checkAlias(d: PairingDeps, alias: string, creator: Address): void {
  if (!PEER_ALIAS_PATTERN.test(alias))
    throw new MessagingError(
      'invalid',
      'alias: a-z, 0-9, ".", "_" and "-", at most 40',
      'alias'
    );
  if (d.store.getPeer(alias) !== null)
    throw new MessagingError('conflict', `a2a:${alias} exists`, 'alias');
  const at = now(d).getTime();
  if (
    d.store
      .pairings()
      .some(
        (p) =>
          p.alias === alias &&
          p.state === 'offered' &&
          Date.parse(p.expiresAt) > at
      )
  )
    throw new MessagingError(
      'conflict',
      `a pairing offer for a2a:${alias} is open; cancel it or choose another alias`,
      'alias'
    );
  if (d.messages.getAgent(clientAddress(creator, alias)) !== null)
    throw new MessagingError(
      'conflict',
      `${clientAddress(creator, alias)} was registered before; choose another alias`,
      'alias'
    );
}

// The client row a pairing writes, under the human who created it.
function clientAddress(creator: Address, alias: string): Address {
  const handle = creator.startsWith('human:')
    ? creator.slice('human:'.length)
    : creator.replace(/[^a-z0-9._-]/gi, '-');
  return `agent:${handle}/a2a.${alias}`;
}

// The peer row and an approved client for the other side, both pinned to its
// key (OD-2: completion approves; the code was the capability), written in
// one transaction after `first` (the offer's CAS) and a re-check that nothing
// took the alias or address meanwhile: no existing row or pin is overwritten.
function writePairedRecords(
  d: PairingDeps,
  peer: PeerRow,
  pin: KeyPin,
  creator: Address,
  first: () => void = () => {}
): void {
  const at = now(d).toISOString();
  const address = clientAddress(creator, peer.alias);
  const taken = () =>
    new MessagingError(
      'conflict',
      `a2a:${peer.alias} was taken meanwhile`,
      'alias'
    );
  d.store.transaction(() => {
    first();
    if (
      d.store.getPeer(peer.alias) !== null ||
      d.store.getClient(address) !== null ||
      d.messages.getAgent(address) !== null
    )
      throw taken();
    d.store.putPeer(peer);
    if (!d.store.setPeerKey(peer.alias, pin))
      throw new MessagingError('conflict', 'this key is already paired');
    d.store.putClient({
      address,
      name: `a2a.${peer.alias}`,
      recipients: [],
      createdBy: creator,
      createdAt: at,
    });
    if (!d.store.setClientKey(address, pin))
      throw new MessagingError('conflict', 'this key is already paired');
    d.store.recordKeyEvent({
      thumbprint: pin.thumbprint,
      event: 'pinned',
      statement: null,
      at,
      pairedId: pin.pairedId,
      jwk: pin.jwk,
    });
    // Last, in messages.db: if it fails, a2a.db's rows roll back with it. The
    // token is never shown: a signature client refuses bearers anyway.
    d.messages.putAgent({
      address,
      displayName: `a2a.${peer.alias}`,
      client: 'a2a',
      tokenHash: tokenHash(randomBytes(32).toString('hex')),
      status: 'approved',
      muted: false,
      approvedBy: creator,
      createdAt: at,
    });
  });
  d.emit(peer.alias, 'added');
}

// The other side's card must carry a Dispatch signature by the key we pin.
async function cardSignedBy(
  peer: PeerRow,
  thumbprint: string,
  jwk: Record<string, string>
): Promise<boolean> {
  return verifyCardSignature(peer.cardJson, (kid) =>
    kid === thumbprint
      ? Promise.resolve(jwk)
      : Promise.reject(new Error('not the paired key'))
  );
}

/** A new offer: the printed code, shown once, and the row that waits for it. */
/**
 * A pairing over a teammate link (T54, T55): the peer has no card URL, so its
 * row names the link, and both records pin its card key with auth 'link'.
 * The link's own registry (remote, branch, link keys) is the caller's.
 */
export function writeLinkPairedRecords(
  d: PairingDeps,
  i: {
    alias: string;
    pairedId: string;
    name: string;
    peer: { thumbprint: string; jwk: Record<string, string> };
    creator: Address;
    creatorTier: 'decide' | 'operator';
  },
  first: () => void = () => {}
): void {
  const at = now(d).toISOString();
  const where = `link:${i.pairedId}`;
  writePairedRecords(
    d,
    {
      alias: i.alias,
      cardUrl: where,
      interfaceUrl: where,
      binding: 'JSONRPC',
      // Streaming: the link client yields on each event the link brings.
      cardJson: JSON.stringify({
        name: i.name.slice(0, 200),
        capabilities: { streaming: true },
      }),
      etag: null,
      fetchedAt: at,
      status: 'active',
      addedBy: i.creator,
      addedTier: i.creatorTier,
      allowHttp: false,
      allowOrigin: false,
      apiKeyHeader: null,
      createdAt: at,
    },
    pairingPin(i.peer, i.pairedId, 'link'),
    i.creator,
    first
  );
}

export function offerPairing(
  d: PairingDeps,
  i: {
    alias: string;
    ourCard: string;
    ttlMin?: number;
    caller: Caller;
    // A teammate link's transport in place of the card URL (T55).
    reach?: Reach;
  }
): { id: string; code: string; fingerprint: string; expiresAt: string } {
  checkAlias(d, i.alias, i.caller.ref);
  const key = ourKey(d);
  const ttl = Math.min(
    TTL_MIN.max,
    Math.max(TTL_MIN.min, Math.round(i.ttlMin ?? TTL_MIN.default))
  );
  const reach: Reach = i.reach ?? { kind: 'url', card: i.ourCard };
  const { code, secretHash } = newPairingCode({
    jwk: key.jwk,
    reach,
    name: ourName(d),
    now: now(d),
    ttlMin: ttl,
  });
  const row: PairingRow = {
    id: code.id,
    role: 'offer',
    secretHash,
    alias: i.alias,
    reach,
    createdBy: i.caller.ref,
    createdTier: tierAllows(i.caller.tier, 'operator') ? 'operator' : 'decide',
    createdAt: now(d).toISOString(),
    expiresAt: code.expires,
    state: 'offered',
    peerThumbprint: null,
    completedAt: null,
  };
  d.store.putPairing(row);
  return {
    id: code.id,
    code: encodePairingCode(code),
    fingerprint: a2aFingerprint(code.thumbprint),
    expiresAt: code.expires,
  };
}

const refusedCode = () =>
  new MessagingError(
    'invalid',
    'the other side refused this code: it expired, was used, or is not theirs',
    'code'
  );

/** Accepts a code: checks the offerer's card and key, proves ours, writes both rows. */
/** Throws unless `ref` may name `alias`: free, and not its own name. */
export function checkPairingAlias(
  d: PairingDeps,
  alias: string,
  ref: Address
): void {
  checkAlias(d, alias, ref);
}

export async function acceptPairing(
  d: PairingDeps,
  i: { code: string; alias: string; ourCard: string; caller: Caller }
): Promise<{ alias: string; sas: string; fingerprint: string }> {
  const code = decodePairingCode(i.code, now(d));
  if (code.reach.kind !== 'url')
    throw new MessagingError(
      'invalid',
      'link pairing is not available yet',
      'code'
    );
  checkAlias(d, i.alias, i.caller.ref);
  const key = ourKey(d);
  const ourThumbprint = ecThumbprint(key.jwk) ?? '';
  const { row: peer } = await checkNewPeer(
    d,
    { alias: i.alias, cardUrl: code.reach.card },
    i.caller,
    true
  );
  if (!(await cardSignedBy(peer, code.thumbprint, code.jwk)))
    throw new MessagingError(
      'invalid',
      "the other side's card is not signed by the key in the code",
      'code'
    );
  const proof = makeProof({
    code,
    reach: { kind: 'url', card: i.ourCard },
    name: ourName(d),
    privateKey: key.privateKey,
    jwk: key.jwk,
  });
  const fetchImpl = pairedFetch(d, peer, code.jwk);
  let reply: { accepted?: unknown; sas?: unknown };
  try {
    const res = await fetchImpl(`${peer.interfaceUrl}${PAIR_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(proof),
    });
    if (res.status !== 200) throw refusedCode();
    reply = (await res.json()) as typeof reply;
  } catch (err) {
    if (err instanceof MessagingError) throw err;
    if (err instanceof PeerHttpError) throw refusedCode();
    throw err;
  }
  const expected = sas(ourThumbprint, code.thumbprint, code.id);
  if (reply.accepted !== true || reply.sas !== expected) throw refusedCode();
  writePairedRecords(
    d,
    peer,
    pairingPin(
      { thumbprint: code.thumbprint, jwk: code.jwk },
      code.id,
      'signature'
    ),
    i.caller.ref
  );
  d.store.putPairing({
    id: code.id,
    role: 'accept',
    secretHash: null,
    alias: i.alias,
    reach: code.reach,
    createdBy: i.caller.ref,
    createdTier: tierAllows(i.caller.tier, 'operator') ? 'operator' : 'decide',
    createdAt: now(d).toISOString(),
    expiresAt: code.expires,
    state: 'completed',
    peerThumbprint: code.thumbprint,
    completedAt: now(d).toISOString(),
  });
  return {
    alias: i.alias,
    sas: expected,
    fingerprint: a2aFingerprint(code.thumbprint),
  };
}

const notFound = () => new Response('not found', { status: 404 });

function pairInvalid(message: string, status = 400): Response {
  return Response.json(
    {
      error: {
        code: status,
        status: 'INVALID_ARGUMENT',
        message,
        reason: 'PAIR_INVALID',
      },
    },
    { status }
  );
}

/**
 * The listener's POST <base>/dispatch/pair: the accepter's proof against an
 * open offer. Every failure before the proof checks out is the same 404; the
 * signed reply names the SAS both sides show.
 */
export async function completePairing(
  d: PairingDeps,
  body: Uint8Array,
  request: RequestParts
): Promise<Response> {
  if (body.byteLength > MAX_PROOF_BYTES) return notFound();
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return notFound();
  }
  const id =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as { id?: unknown }).id
      : undefined;
  const row = typeof id === 'string' ? d.store.pairing(id) : null;
  if (row === null || row.role !== 'offer') return notFound();
  const checked = checkProof(raw, row, now(d));
  if (!checked.ok) return notFound();
  const { proof, thumbprint } = checked;
  const reach = proof.reach;
  if (reach.kind !== 'url') return notFound();
  // The creator must still stand at the offer's tier (XH-R3: a revoked or
  // lowered teammate's offer completes nothing), checked before any fetch.
  if (d.creatorTier !== undefined) {
    const tier = d.creatorTier(row.createdBy);
    if (tier === null || !tierAllows(tier, row.createdTier)) {
      d.store.setPairingState(row.id, 'canceled');
      return notFound();
    }
  }
  let peer: PeerRow;
  try {
    ({ row: peer } = await checkNewPeer(
      d,
      { alias: row.alias, cardUrl: reach.card },
      { tier: row.createdTier, ref: row.createdBy },
      true
    ));
  } catch {
    // Fixed: the error would describe this side's network to the caller.
    return pairInvalid("the accepting side's card could not be checked");
  }
  if (!(await cardSignedBy(peer, thumbprint, proof.jwk)))
    return pairInvalid("the accepting side's card is not signed by its key");
  const key = ourKey(d);
  let completed = true;
  try {
    writePairedRecords(
      d,
      peer,
      pairingPin({ thumbprint, jwk: proof.jwk }, row.id, 'signature'),
      row.createdBy,
      () => {
        completed = d.store.completePairing(
          row.id,
          thumbprint,
          now(d).toISOString()
        );
        if (!completed) throw new Error('not offered');
      }
    );
  } catch (err) {
    if (!completed) return notFound();
    return pairInvalid(
      err instanceof MessagingError ? err.message : 'conflict',
      409
    );
  }
  const shared = sas(ecThumbprint(key.jwk) ?? '', thumbprint, row.id);
  d.notices.send(
    row.alias,
    'paired',
    `a2a:${row.alias} paired (fingerprint ${a2aFingerprint(thumbprint)}, SAS ${shared}), offered by ${row.createdBy}.`
  );
  return signResponseFor(
    Response.json({ accepted: true, sas: shared }),
    request,
    key,
    now(d)
  );
}

/** Pairings for the list: no secret, and the SAS once completed. */
export function pairingSummaries(d: PairingDeps): Record<string, unknown>[] {
  const signer = d.signer?.() ?? null;
  const ours = signer === null ? null : ecThumbprint(signer.publicJwk());
  return d.store.pairings().map((p) => ({
    id: p.id,
    role: p.role,
    alias: p.alias,
    state:
      p.state === 'offered' && Date.parse(p.expiresAt) <= now(d).getTime()
        ? 'expired'
        : p.state,
    createdBy: p.createdBy,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    completedAt: p.completedAt,
    fingerprint:
      p.peerThumbprint === null ? null : a2aFingerprint(p.peerThumbprint),
    sas:
      p.peerThumbprint === null || ours === null
        ? null
        : sas(ours, p.peerThumbprint, p.id),
  }));
}

/** How long to wait before each retry of an unpair notice; then it gives up. */
export interface UnpairDeps extends PairingDeps {
  // Revokes a paired client the way a revoke route does (closes its asks).
  revokeClient: (address: Address) => void;
  // Publishes the unpair notice on a teammate link and runs a pass, so it is
  // on the branch before the link goes; true once published there.
  linkUnpair?: (alias: string, pairedId: string) => Promise<boolean>;
  changed: () => void;
  backoffMs?: number[];
}

/**
 * Unpairing (P5). Locally, both records of a pairing go at once: the client
 * is revoked and the peer disabled, its mail parked. A signed notice then
 * tells the other side, retried on the backoff; once it is heard (or given
 * up on) the peer row is removed and its parked mail fails.
 */
export class Unpairer {
  private readonly retries: NoticeRetries;
  private stopped = false;
  constructor(private readonly d: UnpairDeps) {
    this.retries = new NoticeRetries(d.store, 'unpair', d.backoffMs);
  }

  /** Resumes the notices a restart interrupted, at their attempt counts. */
  resume(): void {
    const pending = new Set(this.d.store.notices('unpair').map((n) => n.id));
    for (const p of this.d.store.pairings())
      if (p.state === 'unpairing') {
        if (!pending.has(p.id)) this.record(p.id);
        this.schedule(p.id);
      }
  }

  private record(id: string): void {
    this.d.store.putNotice({
      kind: 'unpair',
      id,
      body: '',
      at: now(this.d).toISOString(),
    });
  }

  stop(): void {
    this.stopped = true;
    this.retries.stop();
  }

  /** The peer row was asked to go; false when a plain removal will do. */
  peerRemoved(alias: string): boolean {
    const id = this.d.store.getPeer(alias)?.pairedId ?? null;
    if (id === null || this.d.store.pairing(id)?.state === 'unpaired')
      return false;
    this.unpair(id);
    return true;
  }

  /** A client was revoked; a paired one takes its pairing with it (and so
   * does XH-R3's cascade, which revokes the creator's clients). */
  clientRevoked(address: Address): void {
    const id = this.d.store.getClient(address)?.pairedId ?? null;
    if (id !== null) this.unpair(id);
  }

  private unpair(id: string): void {
    const state = this.d.store.pairing(id)?.state;
    if (state === 'unpairing' || state === 'unpaired') return;
    this.d.store.setPairingState(id, 'unpairing');
    this.record(id);
    this.disable(id);
    this.d.changed();
    this.schedule(id);
  }

  // Revokes the client and disables the peer of pairing `id`; the peer's
  // rows stay, parked, until the unpair settles.
  private disable(id: string, change: PeerChange = 'disabled'): PeerRow | null {
    const client = this.d.store.clients().find((c) => c.pairedId === id);
    const agent =
      client === undefined ? null : this.d.messages.getAgent(client.address);
    if (agent !== null && agent.status !== 'revoked') {
      this.d.messages.putAgent({
        ...agent,
        status: 'revoked',
        approvedBy: null,
      });
      this.d.revokeClient(agent.address);
    }
    const peer = this.peerOf(id);
    if (peer !== null && peer.status !== 'disabled') {
      this.d.store.setPeerStatus(peer.alias, 'disabled');
      this.d.emit(peer.alias, change);
    }
    return peer;
  }

  private peerOf(id: string): PeerRow | null {
    return this.d.store.peers().find((p) => p.pairedId === id) ?? null;
  }

  private schedule(id: string): void {
    void this.retries.start(
      id,
      () => this.send(id),
      (told) => this.settle(id, told)
    );
  }

  // One unpair notice; true once the other side answered it signed.
  private async send(id: string): Promise<boolean> {
    const peer = this.peerOf(id);
    if (peer === null || peer.keyJwk == null) return true;
    // Over a link the notice is an op the other side reads when it can.
    if (peer.auth === 'link')
      return (await this.d.linkUnpair?.(peer.alias, id)) ?? true;
    const res = await pairedFetch(
      this.d,
      peer,
      peer.keyJwk
    )(`${peer.interfaceUrl}${UNPAIR_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(unpairNotice(id, now(this.d))),
    });
    // Signed either way: heard, or the other side no longer has it.
    return res.status === 200 || res.status === 404;
  }

  private settle(id: string, told: boolean): void {
    if (this.stopped) return;
    this.d.store.setPairingState(id, 'unpaired');
    const peer = this.peerOf(id);
    if (peer !== null) {
      removePeer(this.d, peer.alias);
      this.d.emit(peer.alias, 'removed');
      if (!told)
        this.d.notices.send(
          peer.alias,
          'unpair-untold',
          `a2a:${peer.alias} was unpaired here, but Dispatch could not tell the other side; they may still try to reach you.`
        );
    }
    this.d.changed();
  }

  /**
   * POST <base>/dispatch/unpair: a notice signed by a paired client's key, for
   * that client's own pairing. A verified sender always gets a signed reply,
   * so it can settle; anything unverified is an unsigned 404.
   */
  async receive(
    auth: AuthResult | null,
    body: Uint8Array | null,
    request: RequestParts
  ): Promise<Response> {
    const signer =
      auth === null ? undefined : auth.ok ? auth.caller : auth.verified;
    if (signer === undefined) return new Response('not found', { status: 404 });
    let raw: unknown = null;
    try {
      raw = JSON.parse(new TextDecoder().decode(body ?? new Uint8Array()));
    } catch {
      // Refused below.
    }
    const notice = parseUnpairNotice(raw);
    const client = this.d.store.getClient(signer.address);
    const known =
      auth?.ok === true && notice !== null && client?.pairedId === notice.id;
    if (known)
      this.drop(
        notice.id,
        (alias) =>
          `a2a:${alias} unpaired: the other side removed this pairing. Its records are kept, disabled.`
      );
    return signResponseFor(
      known
        ? Response.json({ unpaired: true })
        : new Response('not found', { status: 404 }),
      request,
      ourKey(this.d),
      now(this.d)
    );
  }

  /**
   * Ends pairing `id` with no notice to the other side (it unpaired, revoked
   * its key, or ours was compromised): the records are kept, disabled, and
   * the owner is told why.
   */
  drop(id: string, notice: (alias: string) => string): string | null {
    this.d.store.setPairingState(id, 'unpaired');
    this.retries.cancel(id);
    this.d.store.deleteNotice('unpair', id);
    const peer = this.disable(id, 'unpaired');
    const alias = peer?.alias ?? null;
    if (alias !== null) this.d.notices.send(alias, 'unpaired', notice(alias));
    this.d.changed();
    return alias;
  }
}
