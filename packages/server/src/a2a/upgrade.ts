import {
  a2aFingerprint,
  checkUpgradeProof,
  dispatchSignatureKids,
  ecThumbprint,
  fetchPeerCard,
  JWKS_PATH,
  makeUpgradeProof,
  pairingPin,
  peerFetch,
  publicJwkOf,
  signedFetch,
  signResponseFor,
  upgradeClientBinding,
  verifyCardSignature,
  verifyRequest,
} from '@dispatch/a2a';
import type {
  KeyPin,
  PairingRow,
  PeerRow,
  ReceivedRequest,
  RequestParts,
} from '@dispatch/a2a';
import { clearPeerCredential, readPeerCredential } from '@dispatch/core';
import type { Address, Message } from '@dispatch/protocol';
import { MessagingError } from '@dispatch/protocol';
import { createPublicKey, randomBytes } from 'node:crypto';
import { basename } from 'node:path';

import { SYSTEM_SENDER } from '../messaging/gates.js';
import type { AuthTier } from '../tiers.js';
import { tierAllows } from '../tiers.js';
import { authenticateA2AClient, tokenHash } from './auth.js';
import type { PairingDeps } from './pairing.js';
import { bearerHeadersFor, offersSignatures, peerGuard } from './peers.js';
import { NoticeRetries } from './retry.js';

// Upgrading a two-sided bearer pair to signatures (P5, spec "Migration").
// The side upgrading proves its key over its bearer; the other side's owner
// approves the key through a question; the approval is sent back over that
// side's bearer, signed, and each side then pins the other's key on its peer
// and client rows and drops both bearers.

export interface UpgradeDeps extends PairingDeps {
  changed: () => void;
  backoffMs?: number[];
}

const UPGRADE_PATH = '/dispatch/upgrade';
// How long a requested upgrade waits for its owner's answer.
const UPGRADE_TTL_MS = 7 * 24 * 3600 * 1000;
const NONCE_CAP = 10_000;

const nowOf = (d: UpgradeDeps): Date => d.now?.() ?? new Date();

const notFound = () => new Response('not found', { status: 404 });

export class Upgrades {
  private readonly retries: NoticeRetries;
  constructor(private readonly d: UpgradeDeps) {
    this.retries = new NoticeRetries(d.store, 'upgrade', d.backoffMs);
  }

  private key() {
    const signer = this.d.signer?.() ?? null;
    if (signer === null)
      throw new MessagingError(
        'conflict',
        "card signing is off; an upgrade needs this project's card key"
      );
    return { ...signer.requestKey(), jwk: signer.publicJwk() };
  }

  /** Resumes approvals still telling the other side. */
  resume(): void {
    for (const n of this.d.store.notices('upgrade')) this.tell(n.id);
  }

  stop(): void {
    this.retries.stop();
  }

  // The key a pending upgrade names, as its 'upgrade-offered' event kept it.
  private keyOf(row: PairingRow): Record<string, string> | null {
    if (row.peerThumbprint === null) return null;
    return (
      this.d.store
        .pairingsThatPinned(row.peerThumbprint)
        .find((p) => p.pairedId === row.id)?.jwk ?? null
    );
  }

  private record(
    role: 'upgrade-out' | 'upgrade-in',
    row: Omit<PairingRow, 'secretHash' | 'completedAt' | 'role' | 'state'>,
    jwk: Record<string, string>
  ): void {
    this.d.store.transaction(() => {
      this.d.store.putPairing({
        ...row,
        role,
        secretHash: null,
        state: 'offered',
        completedAt: null,
      });
      this.d.store.recordKeyEvent({
        thumbprint: row.peerThumbprint!,
        event: 'upgrade-offered',
        statement: null,
        at: row.createdAt,
        pairedId: row.id,
        jwk,
      });
    });
  }

  /**
   * This side starts: checks the peer's card offers signatures and is signed
   * by a key whose fingerprint the human confirmed, then sends its own key's
   * proof over its bearer. Nothing is sent when the fingerprint differs.
   */
  async start(i: {
    alias: string;
    confirmFingerprint: string;
    ourCard: string;
    caller: { tier: AuthTier; ref: Address };
    // The client the other side reaches this agent as: its approval must
    // come back over that client's bearer.
    client?: string;
  }): Promise<{ state: 'pending'; id: string; fingerprint: string }> {
    const peer = this.d.store.getPeer(i.alias);
    if (peer === null)
      throw new MessagingError('not-found', `no A2A peer ${i.alias}`);
    const client = i.client === undefined ? null : this.clientNamed(i.client);
    if (peer.auth === 'signature')
      throw new MessagingError(
        'conflict',
        `a2a:${i.alias} already signs its requests`
      );
    const guard = peerGuard(this.d, peer);
    const fetched = await fetchPeerCard(peer.cardUrl, {
      allowHttp: peer.allowHttp,
      ...(this.d.fetchImpl === undefined
        ? {}
        : { fetchImpl: this.d.fetchImpl }),
      ...(guard === undefined ? {} : { guard }),
    });
    const card = fetched.json as Record<string, unknown>;
    if (!offersSignatures(card))
      throw new MessagingError(
        'invalid',
        'this peer cannot sign: its card does not offer signed requests',
        'alias'
      );
    const peerJwk = await this.signingKeyOf(peer, card);
    const kid = ecThumbprint(peerJwk)!;
    const fingerprint = a2aFingerprint(kid);
    if (normalize(i.confirmFingerprint) !== normalize(fingerprint))
      throw new MessagingError(
        'invalid',
        `the fingerprint does not match: a2a:${i.alias} presents ${fingerprint}`,
        'confirmFingerprint'
      );
    const key = this.key();
    const credential = readPeerCredential(this.d.rootDir, i.alias);
    if (credential === null)
      throw new MessagingError(
        'conflict',
        `a2a:${i.alias} has no stored bearer to upgrade over`
      );
    const proof = makeUpgradeProof({
      reach: { kind: 'url', card: i.ourCard },
      name: (this.d.policy().name ?? basename(this.d.rootDir)).slice(0, 100),
      privateKey: key.privateKey,
      jwk: key.jwk,
      now: nowOf(this.d),
      audience: new URL(peer.interfaceUrl).origin,
      client: upgradeClientBinding(credential.token),
    });
    const at = nowOf(this.d);
    this.record(
      'upgrade-out',
      {
        id: proof.id,
        alias: i.alias,
        reach: { kind: 'url', card: peer.cardUrl },
        createdBy: i.caller.ref,
        createdTier: tierAllows(i.caller.tier, 'operator')
          ? 'operator'
          : 'decide',
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + UPGRADE_TTL_MS).toISOString(),
        peerThumbprint: kid,
      },
      peerJwk
    );
    if (client !== null)
      this.d.store.putNotice({
        kind: 'upgrade-client',
        id: proof.id,
        body: client,
        at: at.toISOString(),
      });
    let status: number | null = null;
    try {
      const res = await this.bearerSigned(peer, peerJwk)(
        `${peer.interfaceUrl}${UPGRADE_PATH}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'request', proof }),
        }
      );
      status = res.status;
    } catch {
      // Told below.
    }
    if (status !== 202) {
      this.d.store.setPairingState(proof.id, 'canceled');
      throw new MessagingError(
        'conflict',
        `a2a:${i.alias} did not take the upgrade${status === null ? '' : ` (HTTP ${status})`}`
      );
    }
    this.d.changed();
    return { state: 'pending', id: proof.id, fingerprint };
  }

  // A bearer client by its address or name, as `clients` commands take it.
  private clientNamed(arg: string): Address {
    const named = `a2a.${arg.replace(/^a2a\./, '')}`;
    const rows = this.d.store
      .clients()
      .filter((c) => c.address === arg || c.name === arg || c.name === named);
    if (rows.length !== 1)
      throw new MessagingError(
        'invalid',
        rows.length === 0
          ? `no A2A client ${arg}`
          : `${arg} names more than one client; pass its address`,
        'client'
      );
    if (rows[0].auth === 'signature')
      throw new MessagingError(
        'conflict',
        `${rows[0].address} already signs its requests`,
        'client'
      );
    return rows[0].address;
  }

  // The key that signs `card`, from the peer's JWKS, checked to sign it.
  private async signingKeyOf(
    peer: PeerRow,
    card: Record<string, unknown>
  ): Promise<Record<string, string>> {
    const guard = peerGuard(this.d, peer);
    const res = await peerFetch({
      headers: {},
      fetchImpl: this.d.fetchImpl,
      timeoutMs: 30_000,
      maxBodyBytes: 64 * 1024,
      guard: guard === undefined ? undefined : { field: 'cardUrl', ...guard },
    })(`${new URL(peer.cardUrl).origin}${JWKS_PATH}`);
    const jwks = (res.status === 200 ? await res.json() : null) as {
      keys?: Record<string, string>[];
    } | null;
    for (const kid of dispatchSignatureKids(card)) {
      const found = jwks?.keys?.find((k) => k.kid === kid);
      if (found === undefined) continue;
      let jwk: Record<string, string>;
      try {
        jwk = publicJwkOf(found);
      } catch {
        continue;
      }
      if (ecThumbprint(jwk) !== kid) continue;
      if (await verifyCardSignature(card, () => Promise.resolve(jwk)))
        return jwk;
    }
    throw new MessagingError(
      'invalid',
      'this peer cannot sign: its card is not signed by a key it serves',
      'alias'
    );
  }

  // A fetch with the peer's bearer, signed by our key, taking only replies
  // signed by `peerJwk`.
  private bearerSigned(
    peer: PeerRow,
    peerJwk: Record<string, string>
  ): typeof fetch {
    const guard = peerGuard(this.d, peer);
    const key = this.key();
    return signedFetch(
      peerFetch({
        headers: bearerHeadersFor(this.d, peer),
        fetchImpl: this.d.fetchImpl,
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

  /**
   * POST <base>/dispatch/upgrade, bearer-authenticated as an existing
   * client: a 'request' carrying the client's proof opens a question for the
   * owner; an 'approved' answers one this side sent. Anything a bearer does
   * not authenticate is an unsigned 404.
   */
  async receive(r: ReceivedRequest, publicUrl: string): Promise<Response> {
    const parts: RequestParts = {
      method: r.method,
      targetUri: `${new URL(publicUrl).origin}${r.path}${r.query}`,
      headers: r.headers,
    };
    const repeat = this.repeatedApproval(r, publicUrl);
    if (repeat !== null)
      return signResponseFor(repeat, parts, this.key(), nowOf(this.d));
    const bearer = /^Bearer[ ]+(\S+)$/i.exec(
      (r.headers.get('authorization') ?? '').trim()
    )?.[1];
    if (bearer === undefined) return notFound();
    const auth = authenticateA2AClient(
      this.d.messages,
      (a) => this.d.store.getClient(a)?.auth ?? null,
      bearer
    );
    if (!auth.ok) return notFound();
    let raw: unknown = null;
    try {
      raw = JSON.parse(new TextDecoder().decode(r.body ?? new Uint8Array()));
    } catch {
      // Refused below.
    }
    const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
      string,
      unknown
    >;
    let res: Response;
    if (body.type === 'request') {
      res = await this.requested(auth.caller.address, body.proof, {
        audience: new URL(publicUrl).origin,
        client: upgradeClientBinding(bearer),
      });
    } else if (body.type === 'approved' && typeof body.id === 'string') {
      res = this.approved(auth.caller.address, body.id, r, publicUrl);
    } else {
      res = Response.json({ error: 'not an upgrade message' }, { status: 400 });
    }
    return signResponseFor(res, parts, this.key(), nowOf(this.d));
  }

  // Whether `r` is signed by the key upgrade `row` confirmed.
  private signedByRowKey(
    row: PairingRow,
    r: ReceivedRequest,
    publicUrl: string
  ): boolean {
    const jwk = this.keyOf(row);
    if (jwk === null || row.peerThumbprint === null) return false;
    const now = nowOf(this.d);
    return verifyRequest(r, {
      configuredOrigin: new URL(publicUrl).origin,
      keyFor: (kid) =>
        kid === row.peerThumbprint
          ? createPublicKey({ key: jwk, format: 'jwk' })
          : null,
      now,
      guardMs: 300_000,
      rememberNonce: (keyid, nonce, expiresAt) =>
        this.d.store.rememberNonce(keyid, nonce, expiresAt, NONCE_CAP, now),
    }).ok;
  }

  // An 'approved' this side already applied, sent again (its first reply was
  // lost): the bearer it came over is gone, so the confirmed key's signature
  // alone answers it, with the same 200 (review N4). Null for anything else.
  private repeatedApproval(
    r: ReceivedRequest,
    publicUrl: string
  ): Response | null {
    let raw: unknown = null;
    try {
      raw = JSON.parse(new TextDecoder().decode(r.body ?? new Uint8Array()));
    } catch {
      return null;
    }
    const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
      string,
      unknown
    >;
    if (body.type !== 'approved' || typeof body.id !== 'string') return null;
    const row = this.d.store.pairing(body.id);
    if (row?.role !== 'upgrade-out' || row.state !== 'completed') return null;
    return this.signedByRowKey(row, r, publicUrl)
      ? Response.json({ upgraded: true })
      : notFound();
  }

  // The other side asks: the client it is (`address`) proves a key; the
  // owner decides. The peer row for that side is the one whose stored card
  // that key signed.
  private async requested(
    address: Address,
    rawProof: unknown,
    expect: { audience: string; client: string }
  ): Promise<Response> {
    const client = this.d.store.getClient(address);
    if (client === null) return notFound();
    const checked = checkUpgradeProof(rawProof, nowOf(this.d), expect);
    if (!checked.ok)
      return Response.json({ error: checked.reason }, { status: 400 });
    const { proof, thumbprint } = checked;
    let peer: PeerRow | null = null;
    for (const p of this.d.store.peers()) {
      if (p.auth === 'signature') continue;
      if (
        await verifyCardSignature(p.cardJson, (kid) =>
          kid === thumbprint
            ? Promise.resolve(proof.jwk)
            : Promise.reject(new Error('not the proof key'))
        )
      ) {
        peer = p;
        break;
      }
    }
    const at = nowOf(this.d);
    this.record(
      'upgrade-in',
      {
        id: proof.id,
        alias: peer?.alias ?? client.name,
        reach: proof.reach,
        createdBy: address,
        createdTier: 'decide',
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + UPGRADE_TTL_MS).toISOString(),
        peerThumbprint: thumbprint,
      },
      proof.jwk
    );
    const fingerprint = a2aFingerprint(thumbprint);
    const { message } = await this.d.engine.send(
      {
        to: [this.d.ownerRef],
        kind: 'question',
        blocking: true,
        choices: ['approve', 'decline'],
        idempotencyKey: `a2a-upgrade:${proof.id}`,
        body: `${client.name} wants to switch to signed requests with key ${fingerprint}${peer === null ? '' : ` (a2a:${peer.alias})`}. Approve only if that matches the fingerprint the other side shows; its bearer token then stops working.`,
      },
      SYSTEM_SENDER
    );
    this.d.store.putNotice({
      kind: 'upgrade-gate',
      id: proof.id,
      body: message.id,
      at: at.toISOString(),
    });
    this.d.changed();
    return Response.json({ pending: true }, { status: 202 });
  }

  // Who may answer an upgrade question: a human here who can decide (the
  // owner, or a live teammate at decide or above), never another replica.
  private canDecide(answer: Message): boolean {
    if (answer.origin !== undefined) return false;
    if (answer.from === this.d.ownerRef) return true;
    if (!answer.from.startsWith('human:')) return false;
    const tier = this.d.creatorTier?.(answer.from) ?? null;
    return tier !== null && tierAllows(tier, 'decide');
  }

  /** An answer to one of this side's upgrade questions. */
  answered(answer: Message): void {
    if (answer.kind !== 'answer' || answer.replyTo === null) return;
    const gate = this.d.store
      .notices('upgrade-gate')
      .find((n) => n.body === answer.replyTo);
    if (gate === undefined || !this.canDecide(answer)) return;
    this.d.store.deleteNotice('upgrade-gate', gate.id);
    const row = this.d.store.pairing(gate.id);
    if (row?.role !== 'upgrade-in' || row.state !== 'offered') return;
    if (answer.choice !== 'approve') {
      this.d.store.setPairingState(row.id, 'canceled');
      this.d.changed();
      return;
    }
    this.d.store.putNotice({
      kind: 'upgrade',
      id: row.id,
      body: '',
      at: nowOf(this.d).toISOString(),
    });
    this.tell(row.id);
  }

  // Tells the side upgrading its upgrade was approved; once it answers signed,
  // this side switches too.
  private tell(id: string): void {
    void this.retries.start(
      id,
      () => this.sendApproval(id),
      (heard) => {
        if (heard) return;
        this.d.store.setPairingState(id, 'canceled');
        const row = this.d.store.pairing(id);
        this.d.notices.send(
          row?.alias ?? id,
          'upgrade-untold',
          `The approved upgrade of ${row?.alias ?? id} to signed requests could not reach the other side; nothing changed. Ask them to upgrade again.`
        );
      }
    );
  }

  private async sendApproval(id: string): Promise<boolean> {
    const row = this.d.store.pairing(id);
    if (row?.role !== 'upgrade-in' || row.state !== 'offered') return true;
    const jwk = this.keyOf(row);
    if (jwk === null) return true;
    const peer = this.d.store.getPeer(row.alias);
    if (peer !== null && peer.auth !== 'signature') {
      const res = await this.bearerSigned(peer, jwk)(
        `${peer.interfaceUrl}${UPGRADE_PATH}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'approved', id }),
        }
      );
      if (res.status !== 200) {
        // It no longer has the upgrade: settled, nothing switched here.
        this.d.store.setPairingState(id, 'canceled');
        return true;
      }
    }
    this.switchToSignatures(row, jwk, row.createdBy, peer);
    return true;
  }

  // The side upgrading hears the approval: signed by the key it confirmed, over
  // the bearer of the client the other side is here.
  private approved(
    address: Address,
    id: string,
    r: ReceivedRequest,
    publicUrl: string
  ): Response {
    // Only an upgrade this side asked for: the other side's owner approves
    // ours, and no requester can approve its own (batch 4 review C1).
    const row = this.d.store.pairing(id);
    if (row?.role !== 'upgrade-out' || row.state !== 'offered')
      return notFound();
    const jwk = this.keyOf(row);
    if (jwk === null || !this.signedByRowKey(row, r, publicUrl))
      return notFound();
    // Over the bearer of the client named at start; with none named, only an
    // approved bearer client with no pin yet.
    const named = this.d.store
      .notices('upgrade-client')
      .find((n) => n.id === id)?.body;
    const client = this.d.store.getClient(address);
    const agent = this.d.messages.getAgent(address);
    if (
      named !== undefined
        ? named !== address
        : client === null ||
          client.auth === 'signature' ||
          client.keyThumbprint != null ||
          agent?.status !== 'approved'
    )
      return notFound();
    const peer = this.d.store.getPeer(row.alias);
    try {
      this.switchToSignatures(row, jwk, address, peer);
    } catch (err) {
      if (!(err instanceof MessagingError)) throw err;
      return Response.json({ error: err.message }, { status: 409 });
    }
    this.d.store.deleteNotice('upgrade-client', id);
    return Response.json({ upgraded: true });
  }

  // Pins `jwk` on the client and the peer of this pairing, drops both
  // bearers (the client's token and the peer's stored credential), and
  // completes the pairing row.
  private switchToSignatures(
    row: PairingRow,
    jwk: Record<string, string>,
    clientAddress: Address,
    peer: PeerRow | null
  ): void {
    const pin: KeyPin = pairingPin(
      { thumbprint: row.peerThumbprint!, jwk },
      row.id,
      'signature'
    );
    const at = nowOf(this.d).toISOString();
    this.d.store.transaction(() => {
      if (!this.d.store.completePairing(row.id, row.peerThumbprint!, at))
        throw new MessagingError(
          'conflict',
          'the upgrade was settled meanwhile'
        );
      // A pin the store refuses (the key is pinned elsewhere) rolls it all back.
      const refused = () =>
        new MessagingError('conflict', 'that key is already pinned here');
      if (
        this.d.store.getClient(clientAddress) !== null &&
        !this.d.store.setClientKey(clientAddress, pin)
      )
        throw refused();
      if (peer !== null && !this.d.store.setPeerKey(peer.alias, pin))
        throw refused();
      this.d.store.recordKeyEvent({
        thumbprint: pin.thumbprint,
        event: 'pinned',
        statement: null,
        at,
        pairedId: row.id,
        jwk,
      });
      const agent = this.d.messages.getAgent(clientAddress);
      if (agent !== null)
        this.d.messages.putAgent({
          ...agent,
          tokenHash: tokenHash(randomBytes(32).toString('hex')),
        });
    });
    if (peer !== null) {
      clearPeerCredential(this.d.rootDir, peer.alias);
      this.d.emit(peer.alias, 'rekeyed');
    }
    this.d.changed();
  }
}

const normalize = (fp: string) => fp.replace(/[\s-]/g, '').toUpperCase();
