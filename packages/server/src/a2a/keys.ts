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
import type { PeerRow, RequestParts } from '@dispatch/a2a';
import {
  readA2AKeyStatement,
  readA2ANextSigningKey,
  replaceA2ASigningKeys,
  writeA2ANextSigningKey,
} from '@dispatch/core';
import { MessagingError } from '@dispatch/protocol';

import type { UnpairDeps, Unpairer } from './pairing.js';
import { pairedFetch } from './pairing.js';
import { peerGuard } from './peers.js';
import { NoticeRetries } from './retry.js';
import { KEY_OVERLAP_MS, newPrivateJwk } from './signing.js';

// Key rotation and revocation (P5): this side's rotations, peers' statements
// arriving, and the well-known fallback for a peer that missed one.

export interface KeyDeps extends UnpairDeps {
  unpairer: Unpairer;
  // Drops the cached signer, so the next use loads the keys as now stored.
  resetSigner: () => void;
}

export interface Rotation {
  fingerprint: string;
  // Paired peers that heard the statement, and those still being retried.
  told: string[];
  untold: string[];
  // After a compromise: the peers that must pair again.
  mustRepair: string[];
  overlapUntil: string | null;
}

type Outcome =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 409; reason: string };

const KEY_CHANGE_PATH = '/dispatch/key-change';
// How often one peer's well-known statement is looked up on unknown keys.
const LOOKUP_EVERY_MS = 5 * 60_000;

const nowOf = (d: KeyDeps): Date => d.now?.() ?? new Date();

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

export class KeyService {
  private readonly lookedUp = new Map<string, number>();
  private readonly retries: NoticeRetries;
  constructor(private readonly d: KeyDeps) {
    this.retries = new NoticeRetries(d.store, 'key-push', d.backoffMs);
  }

  /** Resumes the pushes a restart interrupted, at their attempt counts. */
  resume(): void {
    for (const n of this.d.store.notices('key-push'))
      void this.schedulePush(n.id);
  }

  stop(): void {
    this.retries.stop();
  }

  private signer() {
    const signer = this.d.signer?.() ?? null;
    if (signer === null)
      throw new MessagingError(
        'conflict',
        'card signing is off; there is no key to rotate'
      );
    return signer;
  }

  // Paired peers a statement goes to: every pairing not yet unpaired,
  // disabled ones included, since they still trust our key.
  private pairedPeers(): PeerRow[] {
    return this.d.store.peers().filter((p) => {
      if (p.auth !== 'signature' || p.pairedId == null || p.keyJwk == null)
        return false;
      const state = this.d.store.pairing(p.pairedId)?.state;
      return state !== 'unpaired' && state !== 'unpairing';
    });
  }

  private schedulePush(id: string): Promise<boolean> {
    return this.retries.start(
      id,
      () => this.push(id),
      (heard) => this.settlePush(id, heard)
    );
  }

  // Sends pairing `id` its pending statements; true once the peer answered
  // each signed (applied, or refused as stale: either way it decided). A
  // statement authenticates itself, so the request is signed by whichever
  // key is active, even one the peer does not know yet.
  private async push(id: string): Promise<boolean> {
    const pending = this.d.store.notices('key-push').find((n) => n.id === id);
    const peer = this.d.store.peers().find((p) => p.pairedId === id);
    if (pending === undefined || peer?.keyJwk == null) return true;
    const send = pairedFetch(
      this.d,
      peer,
      peer.keyJwk,
      this.signer().requestKey()
    );
    for (const statement of JSON.parse(pending.body) as unknown[])
      await send(`${peer.interfaceUrl}${KEY_CHANGE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(statement),
      });
    return true;
  }

  private settlePush(id: string, heard: boolean): void {
    const alias = this.d.store.peers().find((p) => p.pairedId === id)?.alias;
    if (!heard && alias !== undefined)
      this.d.notices.send(
        alias,
        'key-push-untold',
        `a2a:${alias} could not be told this project's key changed; it will look the change up the next time our reply surprises it.`
      );
  }

  /**
   * Rotates the card key. Planned: the new key signs at once, the old one
   * signs a key-change statement each peer re-pins from, and both are served
   * through the overlap. Compromised (allowed during an overlap): every key a
   * peer may pin signs its own revocation, all of them are replaced by a new
   * key at once, and every pairing must be made again.
   */
  async rotate(compromised: boolean): Promise<Rotation> {
    const signer = this.signer();
    const inUse = signer.keysInUse();
    if (!compromised && inUse.length > 1)
      throw new MessagingError(
        'conflict',
        'a rotation is still in its 7-day overlap; it ends on its own'
      );
    const at = nowOf(this.d);
    const next = newPrivateJwk();
    let statements: unknown[];
    if (compromised) {
      statements = inUse.map((k) =>
        makeRevocation({ oldJwk: k.jwk, oldKey: k.privateKey, at })
      );
      // The well-known path serves one statement: the signing key's
      // revocation, the one a peer that missed every push still pins.
      await replaceA2ASigningKeys(
        this.d.rootDir,
        next,
        JSON.stringify(statements[0])
      );
    } else {
      const current = inUse[0];
      statements = [
        makeKeyChange({
          oldJwk: current.jwk,
          oldKey: current.privateKey,
          newJwk: publicJwkOf(next),
          at,
        }),
      ];
      if (
        !(await writeA2ANextSigningKey(
          this.d.rootDir,
          { jwk: next, at: at.toISOString() },
          JSON.stringify(statements[0])
        ))
      )
        throw new MessagingError('conflict', 'a rotation is already under way');
    }
    this.d.resetSigner();
    const peers = this.pairedPeers();
    const body = JSON.stringify(statements);
    for (const peer of peers)
      this.d.store.putNotice({
        kind: 'key-push',
        id: peer.pairedId!,
        body,
        at: at.toISOString(),
      });
    const told: string[] = [];
    const untold: string[] = [];
    await Promise.all(
      peers.map(async (peer) => {
        const heard = await this.schedulePush(peer.pairedId!);
        (heard ? told : untold).push(peer.alias);
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

  /** This project's key, and a rotation's next key through its overlap. */
  show(): {
    current: { fingerprint: string };
    next: { fingerprint: string; since: string; until: string } | null;
  } {
    const [current, next] = this.signer().keysInUse();
    const read = readA2ANextSigningKey(this.d.rootDir);
    const since = read.status === 'ok' ? read.next.at : null;
    return {
      current: { fingerprint: a2aFingerprint(current.keyid) },
      next:
        next === undefined || since === null
          ? null
          : {
              fingerprint: a2aFingerprint(next.keyid),
              since,
              until: new Date(Date.parse(since) + KEY_OVERLAP_MS).toISOString(),
            },
    };
  }

  /**
   * The statement served at KEY_STATEMENT_PATH, or null. It is only the
   * last one: a peer two rotations behind cannot catch up from it, finds no
   * statement for the key it pins, and must pair again.
   */
  statement(): string | null {
    return readA2AKeyStatement(this.d.rootDir);
  }

  /**
   * POST <base>/dispatch/key-change: a key-change or revocation statement.
   * It authenticates itself (signed by the key it names, which a pairing
   * here pins or once pinned), so the request needs no signature: a revoked
   * key can still revoke itself. The reply is always signed, so the sender
   * can settle.
   */
  async receive(
    body: Uint8Array | null,
    request: RequestParts
  ): Promise<Response> {
    let raw: unknown = null;
    try {
      raw = JSON.parse(new TextDecoder().decode(body ?? new Uint8Array()));
    } catch {
      // Refused below.
    }
    const outcome = this.applyStatement(raw);
    const res = outcome.ok
      ? Response.json({ applied: true })
      : outcome.status === 404
        ? new Response('not found', { status: 404 })
        : Response.json({ error: outcome.reason }, { status: outcome.status });
    return signResponseFor(
      res,
      request,
      this.signer().requestKey(),
      nowOf(this.d)
    );
  }

  // A key change re-pins the pairing that pins its old key; a revocation
  // drops every pairing that ever pinned the revoked key, so a hostile key
  // change made with a stolen key cannot outrun the owner's revocation.
  private applyStatement(raw: unknown): Outcome {
    const unknown: Outcome = { ok: false, status: 404, reason: 'unknown key' };
    if (!isRecord(raw)) return unknown;
    if (typeof raw.revoked === 'string') return this.applyRevocation(raw);
    if (typeof raw.old !== 'string') return unknown;
    const client = this.d.store.clientByThumbprint(raw.old);
    if (client?.pairedId == null || client.keyJwk == null) return unknown;
    if (this.d.store.pairing(client.pairedId)?.state === 'unpaired')
      return unknown;
    return this.applyKeyChange(client.pairedId, client.keyJwk, raw);
  }

  private applyRevocation(raw: Record<string, unknown>): Outcome {
    const revoked = raw.revoked as string;
    const candidates = [...this.d.store.pairingsThatPinned(revoked)];
    const client = this.d.store.clientByThumbprint(revoked);
    if (client?.pairedId != null && client.keyJwk != null)
      candidates.push({ pairedId: client.pairedId, jwk: client.keyJwk });
    let applied = false;
    let reason = 'unknown key';
    for (const { pairedId, jwk } of candidates) {
      if (this.d.store.pairing(pairedId)?.state === 'unpaired') continue;
      const check = checkRevocation(raw, jwk);
      if (!check.ok) {
        reason = check.reason;
        continue;
      }
      this.d.unpairer.drop(
        pairedId,
        (a) =>
          `a2a:${a} revoked its key as compromised; the pairing is disabled. Pair again to trust its new key.`
      );
      applied = true;
    }
    if (applied) return { ok: true };
    return candidates.length === 0
      ? { ok: false, status: 404, reason }
      : { ok: false, status: 400, reason };
  }

  // Re-pins pairing `id`, whose rows pin `pinned`, from a key change.
  private applyKeyChange(
    id: string,
    pinned: Record<string, string>,
    raw: unknown
  ): Outcome {
    const peer = this.d.store.peers().find((p) => p.pairedId === id) ?? null;
    const alias = peer?.alias ?? id;
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
    try {
      this.d.store.transaction(() => {
        if (
          (client !== undefined &&
            !this.d.store.setClientKey(client.address, pin)) ||
          (peer !== null && !this.d.store.setPeerKey(peer.alias, pin))
        )
          throw new MessagingError('conflict', 'that key is already paired');
        this.d.store.recordKeyEvent({
          thumbprint: change.newThumbprint,
          event: 'pinned',
          statement: JSON.stringify(raw),
          at: change.at,
          pairedId: id,
          jwk: change.newJwk,
        });
      });
    } catch (err) {
      if (!(err instanceof MessagingError)) throw err;
      return { ok: false, status: 409, reason: err.message };
    }
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
    // Only a statement about the key this peer is pinned to counts.
    const ours =
      isRecord(raw) &&
      (raw.old === peer.keyThumbprint || raw.revoked === peer.keyThumbprint);
    if (ours && this.applyStatement(raw).ok) {
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
