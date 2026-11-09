import type { LinearAccountRecord } from '@dispatch-foo/core';
import type { Database } from 'bun:sqlite';

import type { Sealer } from '../linear.js';
import type { LinearGrants } from '../planner/grants.js';
import type { WorkspaceHost } from './host.js';

// The Linear workspaces installed on app.dispatch.foo, each served by its own
// dispatchd (WorkspaceHost). The install (Linear `actor=app`) is the daemon's
// project connection; each member gets a teammate token, minted once by the
// daemon and sealed here, and hands the daemon their own Linear grant so their
// edits reach Linear as them. Requests go through `request`, which swaps the
// page's view token for that member's teammate token.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace_installs (
  org_id TEXT PRIMARY KEY, url_key TEXT NOT NULL, org_name TEXT NOT NULL,
  installed_by TEXT NOT NULL, installed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_installs_url_key ON workspace_installs (url_key);
CREATE TABLE IF NOT EXISTS workspace_members (
  user_id TEXT NOT NULL, org_id TEXT NOT NULL, handle TEXT NOT NULL,
  token_sealed TEXT NOT NULL, PRIMARY KEY (user_id, org_id)
);
`;

/** The request headers a member's request keeps on its way to the daemon. */
const FORWARDED = ['content-type', 'accept', 'x-dispatch-request-id'];
/** The response headers that come back; never the daemon's cookies. */
const RETURNED = ['content-type', 'cache-control', 'etag', 'last-modified'];

function pick(from: Headers, names: readonly string[]): Headers {
  const out = new Headers();
  for (const name of names) {
    const value = from.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

export interface InstalledWorkspace {
  orgId: string;
  name: string;
}

export class HostedWorkspaces {
  // One mint per person and workspace at a time: two tabs opening together
  // would otherwise mint twice and keep whichever wrote last.
  private readonly minting = new Map<string, Promise<string>>();

  constructor(
    private readonly db: Database,
    private readonly sealer: Sealer,
    private readonly host: WorkspaceHost,
    private readonly grants: LinearGrants,
    private readonly clientId: string,
    private readonly now: () => number = Date.now
  ) {
    db.exec(SCHEMA);
  }

  /** The installed workspace a URL key names, or null. */
  byKey(urlKey: string): InstalledWorkspace | null {
    const row = this.db
      .query<{ org_id: string; org_name: string }, [string]>(
        'SELECT org_id, org_name FROM workspace_installs WHERE url_key = ?'
      )
      .get(urlKey);
    return row === null ? null : { orgId: row.org_id, name: row.org_name };
  }

  /**
   * Installs Dispatch on a workspace: the app's grant becomes its daemon's
   * Linear connection, then the daemon links every team it can see and pulls
   * their issues down. A reinstall replaces the connection and keeps the board.
   */
  async install(userId: string, record: LinearAccountRecord): Promise<void> {
    const org = record.organization;
    await this.host.install(org.id, record);
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO workspace_installs (org_id, url_key, org_name, installed_by, installed_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (org_id) DO UPDATE SET url_key = excluded.url_key,
             org_name = excluded.org_name, installed_by = excluded.installed_by,
             installed_at = excluded.installed_at`
        )
        .run(org.id, org.urlKey, org.name, userId, this.now());
      // Another workspace that held this key before a rename gives it up.
      this.db
        .query(
          'DELETE FROM workspace_installs WHERE url_key = ? AND org_id != ?'
        )
        .run(org.urlKey, org.id);
    })();
    const teams = await this.host.request(org.id, '/api/linear/teams');
    if (!teams.ok) throw new Error(`Linear teams (${String(teams.status)})`);
    const teamIds = ((await teams.json()) as { id: string }[]).map((t) => t.id);
    const linked = await this.host.request(org.id, '/api/config', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linear: { enabled: true, teamIds } }),
    });
    if (!linked.ok) throw new Error(`link teams (${String(linked.status)})`);
    const imported = await this.host.request(org.id, '/api/linear/import', {
      method: 'POST',
    });
    if (!imported.ok) throw new Error(`import (${String(imported.status)})`);
  }

  /**
   * A member's request to their workspace's daemon, sent with their teammate
   * token. A token the daemon no longer knows (its home was reset) is minted
   * again once.
   */
  async request(
    userId: string,
    orgId: string,
    pathAndQuery: string,
    req: Request
  ): Promise<Response> {
    const headers = pick(req.headers, FORWARDED);
    const body =
      req.method === 'GET' || req.method === 'HEAD'
        ? undefined
        : await req.arrayBuffer();
    const send = async (token: string) =>
      this.host.request(
        orgId,
        pathAndQuery,
        {
          method: req.method,
          headers,
          ...(body === undefined ? {} : { body }),
        },
        token
      );
    let res = await send(await this.memberToken(userId, orgId));
    if (res.status === 401) {
      this.forget(userId, orgId);
      res = await send(await this.memberToken(userId, orgId));
    }
    return new Response(res.body, {
      status: res.status,
      headers: pick(res.headers, RETURNED),
    });
  }

  /** Where a member's live-update socket connects, with their token. */
  async socket(
    userId: string,
    orgId: string
  ): Promise<{ url: string; token: string }> {
    const token = await this.memberToken(userId, orgId);
    const daemon = await this.host.ensure(orgId);
    return { url: `ws://127.0.0.1:${String(daemon.port)}/ws`, token };
  }

  // The member's teammate token, minted on first use. Every call also hands
  // the daemon a newer Linear grant if the person granted one since.
  private async memberToken(userId: string, orgId: string): Promise<string> {
    const row = this.db
      .query<{ handle: string; token_sealed: string }, [string, string]>(
        'SELECT handle, token_sealed FROM workspace_members WHERE user_id = ? AND org_id = ?'
      )
      .get(userId, orgId);
    if (row !== null) {
      await this.handOff(userId, orgId, row.handle);
      return this.sealer.open(row.token_sealed);
    }
    const slot = `${userId}\u0000${orgId}`;
    let pending = this.minting.get(slot);
    if (pending === undefined) {
      pending = this.mint(userId, orgId).finally(() =>
        this.minting.delete(slot)
      );
      this.minting.set(slot, pending);
    }
    return pending;
  }

  private async mint(userId: string, orgId: string): Promise<string> {
    const profile = this.grants.profile(userId, orgId);
    if (profile === null)
      throw new Error('open the workspace from app.dispatch.foo again');
    // Guests ask; members decide (any non-guest member controls settings).
    const res = await this.host.request(orgId, '/api/team/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: profile.email,
        displayName: profile.displayName,
        tier: profile.guest ? 'request' : 'decide',
      }),
    });
    if (res.status !== 201)
      throw new Error(`mint a member token (${String(res.status)})`);
    const { token, handle } = (await res.json()) as {
      token: string;
      handle: string;
    };
    this.db
      .query(
        `INSERT INTO workspace_members (user_id, org_id, handle, token_sealed) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, org_id) DO UPDATE SET handle = excluded.handle, token_sealed = excluded.token_sealed`
      )
      .run(userId, orgId, handle, this.sealer.seal(token));
    await this.handOff(userId, orgId, handle);
    return token;
  }

  // Gives the daemon the person's Linear grant, then forgets the tokens here:
  // from then on the daemon alone refreshes them. A grant the daemon refuses
  // stays here, and their edits go out as the app until it is accepted.
  private async handOff(
    userId: string,
    orgId: string,
    handle: string
  ): Promise<void> {
    const grant = this.grants.handoff(userId, orgId);
    if (grant === null) return;
    const at = new Date(this.now()).toISOString();
    const record: LinearAccountRecord = {
      version: 1,
      clientId: this.clientId,
      accessToken: grant.tokens.accessToken,
      refreshToken: grant.tokens.refreshToken,
      expiresAt: new Date(
        grant.tokens.expiresAt ?? this.now() + 86_400_000
      ).toISOString(),
      scope: ['read', 'write'],
      user: { id: grant.linearUserId, ...grant.profile },
      organization: grant.org,
      signedInAt: at,
      refreshedAt: null,
    };
    const res = await this.host.request(
      orgId,
      `/api/team/tokens/${encodeURIComponent(handle)}/linear`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(record),
      }
    );
    if (res.status === 204) this.grants.release(userId, orgId);
  }

  private forget(userId: string, orgId: string): void {
    this.db
      .query('DELETE FROM workspace_members WHERE user_id = ? AND org_id = ?')
      .run(userId, orgId);
  }
}
