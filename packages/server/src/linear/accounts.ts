// The daemon's side of a person's Linear sign-in: hands out a fresh access
// token per request (refreshing first when it is close to expiry), turns a
// sign-in Linear ended into "signed out", and signs out (delete, then
// revoke). The token pair itself lives in core's linearAccounts.ts slot of
// the 0600 credentials file; nothing here keeps a token in memory past the
// request that needed it.
//
// Refreshes are single-flight across processes: several daemons share
// credentials.json, and Linear rotates the refresh token on every refresh,
// so two daemons spending the same one would end the grant. Each refresh
// takes the refresh lock, re-reads the record, refreshes only if still due,
// and stores the new pair by compare-and-set before anything uses it.
import {
  hasLinearAccounts,
  listLinearAccounts,
  readLinearAccount,
  removeLinearAccount,
  replaceLinearAccountTokens,
  withLinearRefreshLock,
  writeLinearAccount,
} from '@dispatch-foo/core';
import type { LinearAccountRecord } from '@dispatch-foo/core';

import type { LinearAuth, LinearFailure } from './client.js';
import type { OAuthEndpoints, RevokeOutcome } from './oauth.js';
import {
  isInvalidGrant,
  OAuthError,
  refreshTokens,
  revokeGrant,
} from './oauth.js';

/** A refresh starts this long before the access token expires. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

/** What a person sees once Linear ended their sign-in. */
export const LINEAR_SIGN_IN_ENDED_MESSAGE =
  'Linear ended your sign-in. Sign in again; until then your changes go through the project connection.';

/** What a write reads when the person signed out while it waited. */
export const LINEAR_SIGNED_OUT_MESSAGE =
  'You are no longer signed in to Linear, so this change goes through the project connection on the next sync.';

/** An access token, or why there is none: signed out (Linear ended or
 *  refused the sign-in, or nothing is stored), or a refresh that could not
 *  finish now (the record is kept and tried again later). `message` says
 *  which, in words a person can act on; it never quotes Linear. */
export type LinearAccess =
  | { ok: true; token: string }
  | { ok: false; signedOut: boolean; message: string };

export interface LinearAccountsDeps {
  endpoints?: OAuthEndpoints;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** DISPATCH_LINEAR_CLIENT_SECRET as the daemon read it once at boot (and
   *  removed from its environment); never stored. */
  clientSecret?: string;
  /** Called when a sign-in starts, ends or is ended by Linear, so the app
   *  refetches (the daemon broadcasts `config.changed`). */
  onChange?: () => void;
  log?: (line: string) => void;
}

// A refresh Linear answered with a refusal rather than a hiccup: the grant
// (or this app's right to renew it) is gone, so retrying cannot help. A
// timeout, a throttle, a 5xx or an answer that could not be read is a
// hiccup: the record is kept and the next request tries again.
function refreshRefused(err: unknown): boolean {
  if (!(err instanceof OAuthError)) return false;
  if (err.code === 'invalid_grant') return true;
  if (err.status === 408 || err.status === 429) return false;
  if (err.status !== null) return err.status >= 400 && err.status < 500;
  // A 200 carrying an OAuth error code is a refusal; the codes postForm
  // makes up for a missing or unreadable answer are not.
  return !['network_error', 'server_error', 'invalid_response'].includes(
    err.code
  );
}

// Why a refresh could not finish now, for the write that waited on it.
function refreshHiccup(err: unknown): string {
  const prefix = 'could not refresh your Linear sign-in';
  if (!(err instanceof OAuthError) || err.code === 'network_error')
    return `${prefix}: Linear did not answer`;
  if (err.status === 429)
    return `${prefix}: Linear asked Dispatch to slow down`;
  if (err.code === 'invalid_response')
    return `${prefix}: Linear's answer could not be used`;
  return `${prefix}: Linear answered with an error`;
}

// What a person reads once Linear refused to renew their sign-in. The code
// is Linear's plain OAuth error code (OAuthError keeps nothing else).
function refusedMessage(err: unknown): string {
  if (isInvalidGrant(err)) return LINEAR_SIGN_IN_ENDED_MESSAGE;
  const code = err instanceof OAuthError ? ` (${err.code})` : '';
  return `Linear refused to renew your sign-in${code}. Sign in again; until then your changes go through the project connection.`;
}

/** The tokens of a grant, enough to revoke it. */
interface Grant {
  refreshToken: string;
  accessToken: string;
  clientId: string;
}

/** The person's Linear sign-ins as this daemon uses them. */
export class LinearAccounts {
  // Organization id -> why Linear ended the sign-in there, until the next.
  private readonly ended = new Map<string, string>();

  constructor(private readonly deps: LinearAccountsDeps = {}) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private callOptions() {
    return {
      ...(this.deps.endpoints === undefined
        ? {}
        : { endpoints: this.deps.endpoints }),
      ...(this.deps.fetchImpl === undefined
        ? {}
        : { fetchImpl: this.deps.fetchImpl }),
      now: () => this.now(),
    };
  }

  // The client secret, when the daemon was started with one.
  private secret(): string | undefined {
    const value = this.deps.clientSecret?.trim();
    return value === undefined || value === '' ? undefined : value;
  }

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.log(`dispatchd: ${l}`)))(line);
  }

  /** The stored sign-in for a workspace, tokens included; never returned
   *  by the API (see publicLinearAccount). */
  read(orgId: string): LinearAccountRecord | null {
    return readLinearAccount(orgId);
  }

  /** Whether any sign-in is stored on this machine (a cheap file read). */
  any(): boolean {
    return hasLinearAccounts();
  }

  /** Every sign-in stored on this machine, tokens included; for the owner's
   *  view to strip and list when a project's workspace cannot be told. */
  list(): LinearAccountRecord[] {
    return listLinearAccounts();
  }

  /** Why Linear ended the sign-in for `orgId` since the last one, or null. */
  endedFor(orgId: string): string | null {
    return this.ended.get(orgId) ?? null;
  }

  // Signed out of `orgId`: why, when Linear ended it, else that the person
  // signed out.
  private signedOut(orgId: string): LinearAccess {
    return {
      ok: false,
      signedOut: true,
      message: this.ended.get(orgId) ?? LINEAR_SIGNED_OUT_MESSAGE,
    };
  }

  // Refreshes are due within the margin of expiry.
  private due(record: LinearAccountRecord): boolean {
    return Date.parse(record.expiresAt) - this.now() <= REFRESH_MARGIN_MS;
  }

  // Whether the stored access token has not expired yet.
  private alive(record: LinearAccountRecord): boolean {
    return Date.parse(record.expiresAt) > this.now();
  }

  /**
   * An access token for `orgId`. Unforced, the stored token unless it is due
   * for a refresh; a refresh that cannot finish now still answers the stored
   * token while it has not expired. Forced with `failedToken` (Linear
   * refused it), a refresh unless another process already replaced that
   * token.
   */
  async access(
    orgId: string,
    opts: { force?: boolean; failedToken?: string } = {}
  ): Promise<LinearAccess> {
    const force = opts.force === true;
    const first = readLinearAccount(orgId);
    if (first === null) return this.signedOut(orgId);
    if (!force && !this.due(first))
      return { ok: true, token: first.accessToken };
    let outcome: { access: LinearAccess; orphan: Grant | null };
    try {
      outcome = await withLinearRefreshLock(() =>
        this.refreshLocked(orgId, opts)
      );
    } catch {
      // The lock could not be had: another process is refreshing for long.
      if (!force && this.alive(first))
        return { ok: true, token: first.accessToken };
      return {
        ok: false,
        signedOut: false,
        message:
          'could not refresh your Linear sign-in: another Dispatch was still refreshing it',
      };
    }
    // A grant nothing on disk holds any more is ended outside the lock, so
    // waiting refreshers are not held up by Linear's revoke endpoint.
    if (outcome.orphan !== null) await this.revoke(outcome.orphan);
    return outcome.access;
  }

  // The refresh itself, holding the refresh lock: re-read, refresh only if
  // still needed, store by compare-and-set, then answer the new token, and
  // any grant left that must be revoked once the lock is released.
  private async refreshLocked(
    orgId: string,
    opts: { force?: boolean; failedToken?: string }
  ): Promise<{ access: LinearAccess; orphan: Grant | null }> {
    const signedOut = { access: this.signedOut(orgId), orphan: null };
    const record = readLinearAccount(orgId);
    if (record === null) return signedOut;
    const force = opts.force === true;
    const stored = {
      access: { ok: true, token: record.accessToken } as const,
      orphan: null,
    };
    if (force) {
      if (
        opts.failedToken !== undefined &&
        record.accessToken !== opts.failedToken
      )
        return stored;
    } else if (!this.due(record)) {
      return stored;
    }
    let next;
    try {
      next = await refreshTokens(
        {
          refreshToken: record.refreshToken,
          clientId: record.clientId,
          ...(this.secret() === undefined
            ? {}
            : { clientSecret: this.secret() }),
        },
        this.callOptions()
      );
    } catch (err) {
      if (!refreshRefused(err)) {
        // A hiccup: an unexpired token is still good until the next try.
        if (!force && this.alive(record)) return stored;
        return {
          access: { ok: false, signedOut: false, message: refreshHiccup(err) },
          orphan: null,
        };
      }
      const message = refusedMessage(err);
      const removed = await removeLinearAccount(orgId, record.refreshToken);
      if (removed === null) {
        // Replaced meanwhile (a new sign-in): that one is not ours to end.
        const now = readLinearAccount(orgId);
        return now === null
          ? signedOut
          : { access: { ok: true, token: now.accessToken }, orphan: null };
      }
      this.ended.set(orgId, message);
      this.log(
        `linear: Linear ${isInvalidGrant(err) ? 'ended' : 'refused to renew'} the sign-in in ${record.organization.urlKey}`
      );
      this.deps.onChange?.();
      return {
        access: { ok: false, signedOut: true, message },
        // A dead grant needs no revoke; one Linear only refused to renew
        // (say it wants the client secret) may still be alive.
        orphan: isInvalidGrant(err) ? null : removed,
      };
    }
    const replaced = await replaceLinearAccountTokens(
      orgId,
      record.refreshToken,
      {
        accessToken: next.accessToken,
        refreshToken: next.refreshToken ?? record.refreshToken,
        expiresAt: next.expiresAt,
        // Linear sometimes leaves `scope` out of a refresh: what was granted
        // before still holds, never the scopes Dispatch asks for.
        scope: next.scope ?? record.scope,
        refreshedAt: new Date(this.now()).toISOString(),
      }
    );
    // Signed out (or in again) meanwhile: the pair just issued must not
    // outlive this call.
    const orphan: Grant | null = replaced
      ? null
      : {
          refreshToken: next.refreshToken ?? record.refreshToken,
          accessToken: next.accessToken,
          clientId: record.clientId,
        };
    if (replaced)
      return { access: { ok: true, token: next.accessToken }, orphan };
    const now = readLinearAccount(orgId);
    return {
      access:
        now === null ? signedOut.access : { ok: true, token: now.accessToken },
      orphan,
    };
  }

  /**
   * The LinearAuth a person client sends with: `Bearer` plus the current
   * access token, refreshed when due; one forced refresh after Linear
   * refuses it. Signed out, every request fails as `auth` with the message
   * a person sees, and the write is recorded like any failure.
   */
  authFor(orgId: string): LinearAuth {
    // Every token this auth handed out, so a message quoting an older one
    // is still redacted.
    const seen = new Set<string>();
    const remember = (token: string) => {
      seen.add(token);
      return token;
    };
    return {
      header: async (): Promise<
        { ok: true; value: string } | LinearFailure
      > => {
        const access = await this.access(orgId);
        if (access.ok)
          return { ok: true, value: `Bearer ${remember(access.token)}` };
        return {
          ok: false,
          kind: access.signedOut ? 'auth' : 'network',
          error: access.message,
        };
      },
      secrets: () => {
        const record = readLinearAccount(orgId);
        return [
          ...seen,
          ...(record === null ? [] : [record.accessToken, record.refreshToken]),
        ];
      },
      renew: async (failedHeader: string) => {
        const failed = failedHeader.replace(/^Bearer /, '');
        const access = await this.access(orgId, {
          force: true,
          failedToken: failed,
        });
        return access.ok && access.token !== failed;
      },
    };
  }

  /**
   * Stores a new sign-in, replacing any for the same workspace, and revokes
   * the grant it replaced (best effort), so one machine holds one grant per
   * workspace. Throws CredentialsUnreadableError, storing nothing, when the
   * credentials file cannot be read.
   */
  async save(record: LinearAccountRecord): Promise<void> {
    const previous = await withLinearRefreshLock(() =>
      writeLinearAccount(record)
    );
    this.ended.delete(record.organization.id);
    this.log(
      `linear: signed in as ${record.user.id} in ${record.organization.urlKey}`
    );
    this.deps.onChange?.();
    if (previous !== null && previous.refreshToken !== record.refreshToken)
      await this.revoke(previous);
  }

  /** Revokes a grant at Linear; never throws. */
  revoke(record: Grant): Promise<RevokeOutcome> {
    const secret = this.secret();
    return revokeGrant(
      {
        refreshToken: record.refreshToken,
        accessToken: record.accessToken,
        clientId: record.clientId,
        ...(secret === undefined ? {} : { clientSecret: secret }),
      },
      this.callOptions()
    );
  }

  /**
   * Signs out of `orgId`: the record is deleted under the refresh lock (so a
   * refresh in flight cannot bring it back), then the grant is revoked. A
   * revoke that fails leaves nothing usable on disk; `revoked` says whether
   * Linear confirmed it.
   */
  async signOut(
    orgId: string
  ): Promise<{ signedOut: boolean; revoked: boolean }> {
    const removed = await withLinearRefreshLock(() =>
      removeLinearAccount(orgId)
    );
    this.ended.delete(orgId);
    if (removed === null) return { signedOut: false, revoked: false };
    this.deps.onChange?.();
    const outcome = await this.revoke(removed);
    this.log(
      `linear: signed out of ${removed.organization.urlKey} (${outcome.revoked ? 'revoked' : `not revoked: ${outcome.reason}`})`
    );
    return { signedOut: true, revoked: outcome.revoked };
  }
}
