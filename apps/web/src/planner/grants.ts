import type { Database } from 'bun:sqlite';

import type { Sealer } from '../linear.js';

// People's read grants on Linear workspaces, for the hosted planner. One row
// per person per workspace (Linear organization); tokens are sealed with the
// service secret. The "Dispatch" Linear app is a public PKCE client, so a
// refresh sends the client id and no secret.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS linear_grants (
  user_id TEXT NOT NULL, org_id TEXT NOT NULL, url_key TEXT NOT NULL,
  org_name TEXT NOT NULL, linear_user_id TEXT NOT NULL,
  access_sealed TEXT NOT NULL, refresh_sealed TEXT,
  expires_at INTEGER, created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, org_id)
);
CREATE INDEX IF NOT EXISTS linear_grants_url_key ON linear_grants (url_key);
`;

// Who the person is in Linear, kept so a hosted workspace's daemon can mint
// their teammate token and take their grant. Added after the table shipped.
const PROFILE_COLUMN = 'ALTER TABLE linear_grants ADD COLUMN profile TEXT';

const TOKEN_URL = 'https://api.linear.app/oauth/token';
const REFRESH_EARLY_MS = 5 * 60_000;

/** Who a person is in a Linear workspace. */
export interface LinearProfile {
  name: string;
  displayName: string;
  email: string;
  guest: boolean;
  admin: boolean;
}

export interface GrantTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms; null when Linear gave no expiry. */
  expiresAt: number | null;
}

/** Linear refused the grant's refresh: it was revoked, so it is gone. */
export class GrantGone extends Error {}

interface Row {
  access_sealed: string;
  refresh_sealed: string | null;
  expires_at: number | null;
}

/** A grant's tokens and profile, for handing to a workspace's daemon. */
export interface GrantHandoff {
  linearUserId: string;
  org: { id: string; name: string; urlKey: string };
  profile: LinearProfile;
  tokens: GrantTokens & { refreshToken: string };
}

// A handed-off grant keeps its row (membership) and no tokens: the daemon
// alone refreshes it from then on, so two refreshers never race.
const HANDED_OFF = '';

export class LinearGrants {
  constructor(
    private readonly db: Database,
    private readonly sealer: Sealer,
    private readonly clientId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {
    db.exec(SCHEMA);
    const columns = db
      .query<{ name: string }, []>('PRAGMA table_info(linear_grants)')
      .all();
    if (!columns.some((c) => c.name === 'profile')) db.exec(PROFILE_COLUMN);
  }

  /** Stores (or replaces) a person's grant; also follows a workspace rename. */
  save(
    userId: string,
    org: { id: string; name: string; urlKey: string },
    linearUserId: string,
    tokens: GrantTokens,
    profile: LinearProfile | null = null
  ): void {
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO linear_grants (user_id, org_id, url_key, org_name, linear_user_id, access_sealed, refresh_sealed, expires_at, created_at, profile)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, org_id) DO UPDATE SET linear_user_id = excluded.linear_user_id,
             access_sealed = excluded.access_sealed, refresh_sealed = excluded.refresh_sealed,
             expires_at = excluded.expires_at, profile = coalesce(excluded.profile, profile)`
        )
        .run(
          userId,
          org.id,
          org.urlKey,
          org.name,
          linearUserId,
          this.sealer.seal(tokens.accessToken),
          tokens.refreshToken === null
            ? null
            : this.sealer.seal(tokens.refreshToken),
          tokens.expiresAt,
          this.now(),
          profile === null ? null : JSON.stringify(profile)
        );
      this.db
        .query(
          'UPDATE linear_grants SET url_key = ?, org_name = ? WHERE org_id = ?'
        )
        .run(org.urlKey, org.name, org.id);
    })();
  }

  /** The workspace a URL key names, if anyone has granted it. */
  workspace(urlKey: string): { orgId: string; name: string } | null {
    const row = this.db
      .query<{ org_id: string; org_name: string }, [string]>(
        'SELECT org_id, org_name FROM linear_grants WHERE url_key = ? LIMIT 1'
      )
      .get(urlKey);
    return row === null ? null : { orgId: row.org_id, name: row.org_name };
  }

  /** A person's standing in a workspace: who they are in Linear, or null. */
  member(userId: string, orgId: string): { linearUserId: string } | null {
    const row = this.db
      .query<{ linear_user_id: string }, [string, string]>(
        'SELECT linear_user_id FROM linear_grants WHERE user_id = ? AND org_id = ?'
      )
      .get(userId, orgId);
    return row === null ? null : { linearUserId: row.linear_user_id };
  }

  /** The workspaces a person has granted, by name. */
  workspacesOf(userId: string): { urlKey: string; name: string }[] {
    return this.db
      .query<{ url_key: string; org_name: string }, [string]>(
        'SELECT url_key, org_name FROM linear_grants WHERE user_id = ? ORDER BY org_name'
      )
      .all(userId)
      .map((r) => ({ urlKey: r.url_key, name: r.org_name }));
  }

  /**
   * A live access token for a person's grant, refreshed first when it expires
   * within five minutes. Throws GrantGone (and forgets the grant) when Linear
   * refuses the refresh.
   */
  async accessToken(userId: string, orgId: string): Promise<string> {
    const row = this.db
      .query<Row, [string, string]>(
        'SELECT access_sealed, refresh_sealed, expires_at FROM linear_grants WHERE user_id = ? AND org_id = ?'
      )
      .get(userId, orgId);
    if (row === null) throw new GrantGone('no grant');
    if (row.access_sealed === HANDED_OFF)
      throw new GrantGone('the workspace daemon holds this grant');
    if (
      row.expires_at === null ||
      row.expires_at - this.now() > REFRESH_EARLY_MS
    )
      return this.sealer.open(row.access_sealed);
    if (row.refresh_sealed === null) return this.forget(userId, orgId);
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.sealer.open(row.refresh_sealed),
        client_id: this.clientId,
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (body.error === 'invalid_grant') return this.forget(userId, orgId);
    if (!res.ok || typeof body.access_token !== 'string')
      throw new Error(`Linear refresh failed (${String(res.status)})`);
    this.db
      .query(
        'UPDATE linear_grants SET access_sealed = ?, refresh_sealed = ?, expires_at = ? WHERE user_id = ? AND org_id = ?'
      )
      .run(
        this.sealer.seal(body.access_token),
        typeof body.refresh_token === 'string'
          ? this.sealer.seal(body.refresh_token)
          : row.refresh_sealed,
        typeof body.expires_in === 'number'
          ? this.now() + body.expires_in * 1000
          : null,
        userId,
        orgId
      );
    return body.access_token;
  }

  /**
   * A grant ready to hand to a hosted workspace's daemon, or null when there
   * is nothing to hand (already handed off, no refresh token, no profile).
   */
  handoff(userId: string, orgId: string): GrantHandoff | null {
    const row = this.db
      .query<
        Row & {
          url_key: string;
          org_name: string;
          linear_user_id: string;
          profile: string | null;
        },
        [string, string]
      >(
        'SELECT access_sealed, refresh_sealed, expires_at, url_key, org_name, linear_user_id, profile FROM linear_grants WHERE user_id = ? AND org_id = ?'
      )
      .get(userId, orgId);
    if (
      row === null ||
      row.access_sealed === HANDED_OFF ||
      row.refresh_sealed === null ||
      row.profile === null
    )
      return null;
    return {
      linearUserId: row.linear_user_id,
      org: { id: orgId, name: row.org_name, urlKey: row.url_key },
      profile: JSON.parse(row.profile) as LinearProfile,
      tokens: {
        accessToken: this.sealer.open(row.access_sealed),
        refreshToken: this.sealer.open(row.refresh_sealed),
        expiresAt: row.expires_at,
      },
    };
  }

  /** The person's profile in a workspace, if their grant recorded one. */
  profile(userId: string, orgId: string): LinearProfile | null {
    const row = this.db
      .query<{ profile: string | null }, [string, string]>(
        'SELECT profile FROM linear_grants WHERE user_id = ? AND org_id = ?'
      )
      .get(userId, orgId);
    if (row === null || row.profile === null) return null;
    return JSON.parse(row.profile) as LinearProfile;
  }

  /** Forgets a grant's tokens once a workspace's daemon holds them; the row
   *  stays, as the person's membership. */
  release(userId: string, orgId: string): void {
    this.db
      .query(
        'UPDATE linear_grants SET access_sealed = ?, refresh_sealed = NULL, expires_at = NULL WHERE user_id = ? AND org_id = ?'
      )
      .run(HANDED_OFF, userId, orgId);
  }

  /** Drops a person's grant (Linear stopped honouring it). */
  revoke(userId: string, orgId: string): void {
    this.db
      .query('DELETE FROM linear_grants WHERE user_id = ? AND org_id = ?')
      .run(userId, orgId);
  }

  private forget(userId: string, orgId: string): never {
    this.revoke(userId, orgId);
    throw new GrantGone('Linear revoked this grant');
  }
}
