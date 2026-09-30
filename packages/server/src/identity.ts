import { createHash, timingSafeEqual } from 'node:crypto';

import type { AuthTier } from './tiers.js';

// Who is on the other end of a request, not just what they may do.
//
// The daemon has always minted exactly two tokens — one per capability tier —
// which is enough to answer "may this call proceed" and not enough to answer
// "who made it". Presence, claims and trustworthy attribution all need the
// second answer, so tokens gain an identity here while keeping the tier they
// already carried.
//
// The team model this maps onto already exists: `.dispatch/team.yml` holds the
// roster (packages/core/src/team.ts) and ActorContext already renders a member
// as `human:<handle>`. Nothing new is invented — the wire simply stops being
// anonymous.

/** Who a presented token authenticates as, and what it may do. */
export interface TokenIdentity {
  /** The team handle, as `team.yml` records it. */
  handle: string;
  /** Serialized ActorRef — `human:<handle>` — ready for an attribution field. */
  ref: string;
  tier: AuthTier;
  /** True for the built-in on-disk agent token, which every run's agent
   *  reads: a request presenting it may be an agent, never provably a human. */
  agentToken?: boolean;
}

// One of the two tokens the daemon mints at startup. They authenticate as the
// operator, so a solo project behaves exactly as it always has.
interface BuiltInEntry extends TokenIdentity {
  hash: Buffer;
}

/** What a caller may safely be shown about who holds credentials: never a
 *  token or a hash, since a list endpoint would otherwise hand them out. */
export interface IssuedTokenSummary {
  handle: string;
  tier: AuthTier;
  builtIn: boolean;
  issuedAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  expired: boolean;
  /** A teammate token that can never authenticate: one for the operator's
   *  handle, issued before that was refused. */
  unusable: boolean;
}

/** What a presented token turned out to be: someone, a credential that has
 *  run out, or nothing at all. Kept apart so a 401 can say "expired on …"
 *  instead of "not recognized" to the person whose token merely aged out. */
export type TokenLookup =
  | { kind: 'valid'; identity: TokenIdentity }
  | { kind: 'expired'; handle: string; expiredAt: string }
  /** A real credential the project's license does not cover right now —
   *  more teammates hold tokens than it has seats for. */
  | { kind: 'refused'; handle: string; reason: string }
  | { kind: 'unknown' };

/**
 * Credentials beyond the built-in pair: the teammates a project has issued
 * tokens to. Supplied by the team module (team/, Elastic License 2.0), which
 * issues them and decides whether the license covers each one; the registry
 * only asks.
 */
export interface CredentialSource {
  /** What a presented token is, given its sha256. */
  lookup: (digest: Buffer) => TokenLookup;
  /** Who holds issued credentials, never the credentials. */
  list: () => IssuedTokenSummary[];
}

/** A token's sha256 — the only form a credential is ever kept in. */
export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** The ActorRef a human handle renders as. Duplicated from core's actor.ts
 *  rather than imported for one string, the same way team.ts duplicates the
 *  handle pattern. */
export function humanRef(handle: string): string {
  return `human:${handle}`;
}

/** Shared by rejectUnauthorized (api.ts) and resolvePrincipal
 *  (messaging/principal.ts) for the same 401 on an expired teammate token. */
export function expiredTokenMessage(handle: string, expiredAt: string): string {
  return (
    `this token for ${handle} expired on ${expiredAt}. Ask whoever runs the ` +
    `daemon to invite you again (\`dispatch team invite ${handle}\`).`
  );
}

/**
 * Every credential this daemon accepts, and who each one speaks for.
 *
 * The two built-in tokens are both attributed to the operator — the person
 * whose machine this daemon runs on — so a solo project behaves exactly as it
 * did before. Anything else presented is asked of `teammates`, when the team
 * module supplies one: that is what lets one shared daemon tell two humans
 * apart.
 *
 * Every entry is held as a hash and compared hash-to-hash, so the comparison
 * is constant-length whatever was presented and no raw token is kept.
 */
export class TokenRegistry {
  private readonly builtIn: BuiltInEntry[];

  constructor(
    pair: { agentToken: string; appToken: string },
    private readonly operatorHandle: string,
    private readonly teammates: CredentialSource | null = null
  ) {
    // Highest tier first, so the app token still wins if the two were ever
    // the same string — the pre-existing behaviour, kept on purpose. The app
    // token is `operator`: it only ever reaches the person at this machine.
    const ref = humanRef(operatorHandle);
    this.builtIn = [
      {
        hash: sha256(pair.appToken),
        handle: operatorHandle,
        ref,
        tier: 'operator',
      },
      {
        hash: sha256(pair.agentToken),
        handle: operatorHandle,
        ref,
        tier: 'request',
        agentToken: true,
      },
    ];
  }

  /** Who this token speaks for, or null when it matches nothing, has
   *  expired, or is not covered by the license. */
  resolve(presented: string | null): TokenIdentity | null {
    const found = this.lookup(presented);
    return found.kind === 'valid' ? found.identity : null;
  }

  /** `resolve`, but saying why a token that matched was still turned away. */
  lookup(presented: string | null): TokenLookup {
    if (presented === null || presented === '') return { kind: 'unknown' };
    const digest = sha256(presented);
    const own = this.builtIn.find((e) => timingSafeEqual(digest, e.hash));
    if (own !== undefined) {
      return {
        kind: 'valid',
        identity: {
          handle: own.handle,
          ref: own.ref,
          tier: own.tier,
          ...(own.agentToken === true ? { agentToken: true } : {}),
        },
      };
    }
    const teammate = this.teammates?.lookup(digest) ?? { kind: 'unknown' };
    // Only the built-in pair speaks for the operator; a teammate token naming
    // their handle matches no one.
    if (
      teammate.kind === 'valid' &&
      teammate.identity.handle === this.operatorHandle
    )
      return { kind: 'unknown' };
    return teammate;
  }

  /** Who currently holds credentials, without the credentials. */
  list(): IssuedTokenSummary[] {
    return [
      ...this.builtIn.map((e) => ({
        handle: e.handle,
        tier: e.tier,
        builtIn: true,
        issuedAt: null,
        expiresAt: null,
        lastUsedAt: null,
        expired: false,
        unusable: false,
      })),
      ...(this.teammates?.list() ?? []).map((t) => ({
        ...t,
        unusable: t.unusable || t.handle === this.operatorHandle,
      })),
    ];
  }
}
