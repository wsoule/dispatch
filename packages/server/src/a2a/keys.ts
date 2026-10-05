import {
  a2aFingerprint,
  checkKeyChange,
  checkRevocation,
  ecThumbprint,
  KEY_STATEMENT_PATH,
  makeKeyChange,
  makeRevocation,
  pairingPin,
  peerFetch,
  publicJwkOf,
  signResponseFor,
} from '@dispatch/a2a';
import type { AuthResult, PeerRow, RequestParts } from '@dispatch/a2a';
import {
  promoteA2ASigningKey,
  readA2AKeyStatement,
  writeA2ANextSigningKey,
} from '@dispatch/core';
import { MessagingError } from '@dispatch/protocol';

import type { UnpairDeps, Unpairer } from './pairing.js';
import { pairedFetch } from './pairing.js';
import { peerGuard } from './peers.js';
import { KEY_OVERLAP_MS, newPrivateJwk } from './signing.js';

// Key rotation and revocation (P5): this side's rotations, peers' statements
// arriving signed, and the well-known fallback for a peer that missed one.

export interface KeyDeps extends UnpairDeps {
  unpairer: Unpairer;
  // Drops the cached signer, so the next use loads the keys as now stored.
  resetSigner: () => void;
}

export interface Rotation {
  fingerprint: string;
  // Paired peers that heard the statement, and those that did not.
  told: string[];
  untold: string[];
  // After a compromise: the peers that must pair again.
  mustRepair: string[];
  overlapUntil: string | null;
}

const KEY_CHANGE_PATH = '/dispatch/key-change';
// How often one peer's well-known statement is looked up on unknown keys.
const LOOKUP_EVERY_MS = 5 * 60_000;

const nowOf = (d: KeyDeps): Date => d.now?.() ?? new Date();

export class KeyService {
  private readonly lookedUp = new Map<string, number>();
  constructor(private readonly d: KeyDeps) {}

  private signer() {
    const signer = this.d.signer?.() ?? null;
    if (signer === null)
      throw new MessagingError(
        'conflict',
        'card signing is off; there is no key to rotate'
      );
    return signer;
  }

  // Active paired peers, the ones a statement goes to.
  private pairedPeers(): PeerRow[] {
    return this.d.store
      .peers()
      .filter(
        (p) =>
          p.auth === 'signature' &&
          p.pairedId != null &&
          p.keyJwk != null &&
          p.status !== 'disabled'
      );
  }

  /**
   * Rotates the card key. Planned: the new key signs at once, the old one
   * signs a key-change statement each peer re-pins from, and both are served
   * through the overlap. Compromised: the old key signs only its own
   * revocation and is gone at once; every pairing must be made again.
   */
  async rotate(compromised: boolean): Promise<Rotation> {
    const current = this.signer().currentKey();
    if (this.signer().oldKey() !== null)
      throw new MessagingError(
        'conflict',
        'a rotation is still in its 7-day overlap; it ends on its own'
      );
    const at = nowOf(this.d);
    const next = newPrivateJwk();
    const statement = compromised
      ? makeRevocation({ oldJwk: current.jwk, oldKey: current.privateKey, at })
      : makeKeyChange({
          oldJwk: current.jwk,
          oldKey: current.privateKey,
          newJwk: publicJwkOf(next),
          at,
        });
    if (
      !writeA2ANextSigningKey(
        this.d.rootDir,
        { jwk: next, at: at.toISOString() },
        JSON.stringify(statement)
      )
    )
      throw new MessagingError('conflict', 'a rotation is already under way');
    if (compromised) promoteA2ASigningKey(this.d.rootDir);
    this.d.resetSigner();
    const peers = this.pairedPeers();
    const told: string[] = [];
    const untold: string[] = [];
    // Signed by the old key, the one each peer still pins.
    await Promise.all(
      peers.map(async (peer) => {
        try {
          const res = await pairedFetch(
            this.d,
            peer,
            peer.keyJwk!,
            current
          )(`${peer.interfaceUrl}${KEY_CHANGE_PATH}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(statement),
          });
          (res.status === 200 ? told : untold).push(peer.alias);
        } catch {
          untold.push(peer.alias);
        }
      })
    );
    const mustRepair: string[] = [];
    if (compromised)
      for (const peer of peers) {
        const alias = this.d.unpairer.drop(
          peer.pairedId!,
          (a) =>
            `a2a:${a} must be paired again: this project's card key was rotated as compromised.`
        );
        if (alias !== null) mustRepair.push(alias);
      }
    return {
      fingerprint: a2aFingerprint(this.signer().requestKey().keyid),
      told: told.sort(),
      untold: untold.sort(),
      mustRepair: mustRepair.sort(),
      overlapUntil: compromised
        ? null
        : new Date(at.getTime() + KEY_OVERLAP_MS).toISOString(),
    };
  }

  /** The statement served at KEY_STATEMENT_PATH, or null. */
  statement(): string | null {
    return readA2AKeyStatement(this.d.rootDir);
  }

  /**
   * POST <base>/dispatch/key-change: a statement from a paired client, the
   * request signed by the key it pins. A verified sender always gets a
   * signed reply; anything else is an unsigned 404.
   */
  async receive(
    auth: AuthResult | null,
    body: Uint8Array | null,
    request: RequestParts
  ): Promise<Response> {
    const signer =
      auth === null ? undefined : auth.ok ? auth.caller : auth.verified;
    if (signer === undefined) return new Response('not found', { status: 404 });
    const client = this.d.store.getClient(signer.address);
    let res: Response;
    if (
      auth?.ok !== true ||
      client?.pairedId == null ||
      client.keyJwk == null
    ) {
      res = new Response('not found', { status: 404 });
    } else {
      let raw: unknown = null;
      try {
        raw = JSON.parse(new TextDecoder().decode(body ?? new Uint8Array()));
      } catch {
        // Refused below.
      }
      const outcome = this.apply(client.pairedId, client.keyJwk, raw);
      res = outcome.ok
        ? Response.json({ applied: true })
        : Response.json({ error: outcome.reason }, { status: outcome.status });
    }
    return signResponseFor(
      res,
      request,
      this.signer().requestKey(),
      nowOf(this.d)
    );
  }

  // Applies a statement to pairing `id`, whose rows pin `pinned`.
  private apply(
    id: string,
    pinned: Record<string, string>,
    raw: unknown
  ): { ok: true } | { ok: false; status: 400 | 409; reason: string } {
    const peer = this.d.store.peers().find((p) => p.pairedId === id) ?? null;
    const alias = peer?.alias ?? id;
    if (
      typeof raw === 'object' &&
      raw !== null &&
      'revoked' in (raw as Record<string, unknown>)
    ) {
      const revoked = checkRevocation(raw, pinned);
      if (!revoked.ok)
        return { ok: false, status: 400, reason: revoked.reason };
      this.d.unpairer.drop(
        id,
        (a) =>
          `a2a:${a} revoked its key as compromised; the pairing is disabled. Pair again to trust its new key.`
      );
      return { ok: true };
    }
    const change = checkKeyChange(raw, pinned);
    if (!change.ok) return { ok: false, status: 400, reason: change.reason };
    // Ordered by `at`: a statement no newer than the one that set the
    // current pin is refused, so a replay never moves it back.
    const last = this.d.store
      .keyEvents(ecThumbprint(pinned) ?? '')
      .filter((e) => e.event === 'pinned')
      .at(-1);
    if (last !== undefined && Date.parse(change.at) <= Date.parse(last.at))
      return {
        ok: false,
        status: 409,
        reason: 'older than the key change already applied',
      };
    const pin = pairingPin(
      { thumbprint: change.newThumbprint, jwk: change.newJwk },
      id,
      'signature'
    );
    const client = this.d.store.clients().find((c) => c.pairedId === id);
    if (
      (client !== undefined &&
        !this.d.store.setClientKey(client.address, pin)) ||
      (peer !== null && !this.d.store.setPeerKey(peer.alias, pin))
    )
      return { ok: false, status: 409, reason: 'that key is already paired' };
    this.d.store.recordKeyEvent({
      thumbprint: change.newThumbprint,
      event: 'pinned',
      statement: JSON.stringify(raw),
      at: change.at,
    });
    this.d.notices.send(
      alias,
      'rotated',
      `a2a:${alias} rotated its key; new fingerprint ${a2aFingerprint(change.newThumbprint)}.`
    );
    if (peer !== null) this.d.emit(peer.alias, 'rekeyed');
    this.d.changed();
    return { ok: true };
  }

  /**
   * A paired peer's reply was signed by a key its pin does not know: looks up
   * its well-known statement and applies it, or tells the owner there is
   * none. At most once per peer every few minutes.
   */
  keyUnknown(alias: string): void {
    const at = nowOf(this.d).getTime();
    if (at - (this.lookedUp.get(alias) ?? 0) < LOOKUP_EVERY_MS) return;
    this.lookedUp.set(alias, at);
    void this.lookUp(alias).catch((err: unknown) =>
      console.error(`a2a: key statement lookup for ${alias} failed`, err)
    );
  }

  private async lookUp(alias: string): Promise<void> {
    const peer = this.d.store.getPeer(alias);
    if (peer?.pairedId == null || peer.keyJwk == null) return;
    const guard = peerGuard(this.d, peer);
    let raw: unknown = null;
    try {
      const res = await peerFetch({
        headers: {},
        fetchImpl: this.d.fetchImpl,
        timeoutMs: 30_000,
        maxBodyBytes: 16 * 1024,
        guard: guard === undefined ? undefined : { field: 'cardUrl', ...guard },
      })(`${new URL(peer.cardUrl).origin}${KEY_STATEMENT_PATH}`);
      if (res.status === 200) raw = await res.json();
    } catch {
      // No statement to be had: told below.
    }
    const outcome =
      raw === null ? null : this.apply(peer.pairedId, peer.keyJwk, raw);
    if (outcome?.ok === true) {
      this.lookedUp.delete(alias);
      return;
    }
    this.d.notices.send(
      alias,
      'key-unknown',
      `a2a:${alias} presents a new key with no statement from the old one; it may have been reinstalled, or it may be an impostor. Re-pair to trust it.`
    );
  }
}
