import {
  a2aFingerprint,
  checkLinkKeysBinding,
  checkProof,
  decodePairingCode,
  ecThumbprint,
  guardPublicUrl,
  linkKeysBinding,
  makeProof,
  sas,
} from '@dispatch/a2a';
import type { LinkKeysBinding } from '@dispatch/a2a';
import type { JsonValue } from '@dispatch/protocol';
import { MessagingError } from '@dispatch/protocol';
import { randomBytes } from 'node:crypto';

import type { LinkHub } from '../team/links/hub.js';
import {
  checkLinkRemote,
  redactRemotes,
  remoteHostUrl,
} from '../team/links/remote.js';
import type { AuthTier } from '../tiers.js';
import { tierAllows } from '../tiers.js';
import type { PairingDeps } from './pairing.js';
import {
  checkPairingAlias,
  offerPairing,
  ourKey,
  ourName,
  writeLinkPairedRecords,
} from './pairing.js';

interface Caller {
  tier: AuthTier;
  ref: string;
}

/** A link's git transport, as a pairing code or proof carries it. */
interface GitTransport {
  kind: 'git';
  remote: string;
  branch: string;
  binding: LinkKeysBinding;
}

const BRANCH = /^dispatch-a2a-[0-9a-f]{16}$/;
// How long past an offer's expiry the accepter waits for the offerer's link.
const PENDING_GRACE_MS = 10 * 60_000;

const now = (d: PairingDeps): Date => d.now?.() ?? new Date();

// A transport the other side wrote: a git remote, a link branch, a binding.
function parseTransport(raw: Record<string, JsonValue>): GitTransport | null {
  const { kind, remote, branch, binding } = raw;
  if (
    kind !== 'git' ||
    typeof remote !== 'string' ||
    !checkLinkRemote(remote) ||
    typeof branch !== 'string' ||
    !BRANCH.test(branch) ||
    typeof binding !== 'object' ||
    binding === null
  )
    return null;
  return {
    kind,
    remote,
    branch,
    binding: binding as unknown as LinkKeysBinding,
  };
}

// M1: the same remote rules on every side. AR1/M2: a local path, or a
// network host that is an IP literal or resolves privately, needs the
// operator tier.
async function mayUse(remote: string, caller: Caller): Promise<void> {
  if (!checkLinkRemote(remote))
    throw new MessagingError(
      'invalid',
      'link.remote must be a plain git remote (no options, controls or helper:: forms)',
      'link.remote'
    );
  if (tierAllows(caller.tier, 'operator')) return;
  const host = remoteHostUrl(remote);
  if (host === null)
    throw new MessagingError(
      'forbidden',
      'a link on a local path needs the operator tier',
      'link.remote'
    );
  try {
    await guardPublicUrl(`https://${new URL(host).hostname}/`, {
      field: 'link.remote',
    });
  } catch (err) {
    throw new MessagingError(
      'forbidden',
      `a link to a private or unresolvable host needs the operator tier (${err instanceof Error ? redactRemotes(err.message) : 'refused'})`,
      'link.remote'
    );
  }
}

function needHub(hub: LinkHub | null): LinkHub {
  if (hub === null)
    throw new MessagingError(
      'conflict',
      'teammate links are off on this machine',
      'link'
    );
  return hub;
}

// This side's link keys, bound under its card key.
function ourBinding(d: PairingDeps, hub: LinkHub): LinkKeysBinding {
  const key = ourKey(d);
  return linkKeysBinding({
    card: { keyid: key.keyid, privateKey: key.privateKey },
    link: hub.ourKeys(),
    at: now(d),
  });
}

/** Offers a pairing reached over a link on `remote`; watches its branch. */
export async function offerLinkPairing(
  d: PairingDeps,
  hub: LinkHub | null,
  i: { alias: string; remote: string; ttlMin?: number; caller: Caller }
): Promise<{
  id: string;
  code: string;
  fingerprint: string;
  expiresAt: string;
}> {
  const links = needHub(hub);
  await mayUse(i.remote, i.caller);
  const branch = `dispatch-a2a-${randomBytes(8).toString('hex')}`;
  const offered = offerPairing(d, {
    alias: i.alias,
    ourCard: '',
    ...(i.ttlMin === undefined ? {} : { ttlMin: i.ttlMin }),
    caller: i.caller,
    reach: {
      kind: 'link',
      transport: {
        kind: 'git',
        remote: i.remote,
        branch,
        binding: ourBinding(d, links) as unknown as JsonValue,
      },
    },
  });
  links.watchOffer({
    pairedId: offered.id,
    alias: i.alias,
    remote: i.remote,
    branch,
  });
  return offered;
}

/**
 * Accepts a link code: checks the offerer's link keys under the key in the
 * code, writes both records, and starts the link with this side's proof in
 * its key op, which the offerer reads to complete.
 */
export async function acceptLinkPairing(
  d: PairingDeps,
  hub: LinkHub | null,
  i: { code: string; alias: string; caller: Caller }
): Promise<{ alias: string; sas: string; fingerprint: string }> {
  const code = decodePairingCode(i.code, now(d));
  if (code.reach.kind !== 'link')
    throw new MessagingError('invalid', 'not a link pairing code', 'code');
  const links = needHub(hub);
  const t = parseTransport(code.reach.transport);
  if (t === null)
    throw new MessagingError('invalid', "the code's link is not valid", 'code');
  await mayUse(t.remote, i.caller);
  const theirs = checkLinkKeysBinding(t.binding, code.jwk);
  if (!theirs.ok)
    throw new MessagingError(
      'invalid',
      "the code's link keys are not bound to its card key",
      'code'
    );
  checkPairingAlias(d, i.alias, i.caller.ref);
  const key = ourKey(d);
  const proof = makeProof({
    code,
    reach: {
      kind: 'link',
      transport: {
        kind: 'git',
        remote: t.remote,
        branch: t.branch,
        binding: ourBinding(d, links) as unknown as JsonValue,
      },
    },
    name: ourName(d),
    privateKey: key.privateKey,
    jwk: key.jwk,
  });
  const at = now(d).toISOString();
  const creatorTier = tierAllows(i.caller.tier, 'operator')
    ? 'operator'
    : 'decide';
  writeLinkPairedRecords(d, {
    alias: i.alias,
    pairedId: code.id,
    name: code.name,
    peer: { thumbprint: code.thumbprint, jwk: code.jwk },
    creator: i.caller.ref,
    creatorTier,
  });
  d.store.putPairing({
    id: code.id,
    role: 'accept',
    secretHash: null,
    alias: i.alias,
    reach: code.reach,
    createdBy: i.caller.ref,
    createdTier: creatorTier,
    createdAt: at,
    expiresAt: code.expires,
    state: 'completed',
    peerThumbprint: code.thumbprint,
    completedAt: at,
  });
  links.add(
    {
      alias: i.alias,
      pairedId: code.id,
      remote: t.remote,
      branch: t.branch,
      signPub: theirs.signPub,
      sealPub: theirs.sealPub,
      createdAt: at,
    },
    { proof: proof as unknown as JsonValue },
    // Pending until the offerer's first op: past the offer's life and a
    // grace period, the pairing is one-sided and fails visibly.
    {
      pendingUntil: new Date(
        Date.parse(code.expires) + PENDING_GRACE_MS
      ).toISOString(),
    }
  );
  return {
    alias: i.alias,
    sas: sas(ecThumbprint(key.jwk) ?? '', code.thumbprint, code.id),
    fingerprint: a2aFingerprint(code.thumbprint),
  };
}

export type OfferCheck =
  | {
      ok: true;
      signPub: string;
      sealPub: string;
      // Writes both records; false when the offer was taken meanwhile.
      complete: () => boolean;
    }
  | { ok: false; why: string };

/**
 * A proof read on an offer's link branch: the same checks as T42's (the MAC
 * under the code's secret, the accepter's signature) plus its link keys
 * bound to its card key. The caller checks the op itself under those keys
 * before calling complete().
 */
export function checkLinkProof(
  d: PairingDeps,
  pairedId: string,
  raw: unknown
): OfferCheck {
  const row = d.store.pairing(pairedId);
  if (row === null || row.role !== 'offer')
    return { ok: false, why: 'no such offer' };
  const checked = checkProof(raw, row, now(d));
  if (!checked.ok)
    return { ok: false, why: 'a proof that does not check out under the code' };
  const { proof, thumbprint } = checked;
  if (proof.reach.kind !== 'link')
    return { ok: false, why: 'a proof without a link' };
  const t = parseTransport(proof.reach.transport);
  const keys = t === null ? null : checkLinkKeysBinding(t.binding, proof.jwk);
  if (keys === null || !keys.ok)
    return { ok: false, why: 'a proof whose link keys are not bound' };
  return {
    ok: true,
    signPub: keys.signPub,
    sealPub: keys.sealPub,
    complete: () => {
      if (d.creatorTier !== undefined) {
        const tier = d.creatorTier(row.createdBy);
        if (tier === null || !tierAllows(tier, row.createdTier)) {
          d.store.setPairingState(row.id, 'canceled');
          return false;
        }
      }
      let completed = true;
      try {
        writeLinkPairedRecords(
          d,
          {
            alias: row.alias,
            pairedId: row.id,
            name: proof.name,
            peer: { thumbprint, jwk: proof.jwk },
            creator: row.createdBy,
            creatorTier: row.createdTier,
          },
          () => {
            completed = d.store.completePairing(
              row.id,
              thumbprint,
              now(d).toISOString()
            );
            if (!completed) throw new Error('not offered');
          }
        );
      } catch {
        return false;
      }
      const key = ourKey(d);
      d.notices.send(
        row.alias,
        'paired',
        `a2a:${row.alias} paired over a link (fingerprint ${a2aFingerprint(thumbprint)}, SAS ${sas(ecThumbprint(key.jwk) ?? '', thumbprint, row.id)}), offered by ${row.createdBy}.`
      );
      return true;
    },
  };
}
