import { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// The team service's own records: who has signed in, their browser sessions,
// teams and their members, invites, device sign-ins in flight, and the
// machines (devices) signed in to a team. Messages live elsewhere, in one
// protocol store per team (hub.ts).

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, github_id INTEGER UNIQUE, login TEXT NOT NULL UNIQUE,
  name TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS web_sessions (
  id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  team_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
  joined_at TEXT NOT NULL, PRIMARY KEY (team_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY, team_id TEXT NOT NULL, created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL, used_by TEXT
);
CREATE TABLE IF NOT EXISTS device_codes (
  device_hash TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE,
  client TEXT NOT NULL, expires_at TEXT NOT NULL, user_id TEXT, team_id TEXT,
  denied INTEGER NOT NULL DEFAULT 0, claimed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
  team_id TEXT NOT NULL, client TEXT NOT NULL, created_at TEXT NOT NULL,
  last_seen TEXT, revoked INTEGER NOT NULL DEFAULT 0, hub_replica TEXT
);
CREATE TABLE IF NOT EXISTS linear_orgs (
  user_id TEXT NOT NULL, org_id TEXT NOT NULL, org_name TEXT NOT NULL,
  seen_at TEXT NOT NULL, PRIMARY KEY (user_id, org_id)
);
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL,
  team_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS oauth_grants (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL,
  team_id TEXT NOT NULL, access_hash TEXT NOT NULL UNIQUE,
  access_expires_at TEXT NOT NULL, refresh_hash TEXT NOT NULL UNIQUE,
  revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
`;

export const FREE_SEATS = 3;
const WEB_SESSION_DAYS = 30;
const INVITE_DAYS = 7;
const DEVICE_CODE_MINUTES = 15;
// No vowels and no easily confused letters, so a code never spells a word or misreads.
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

export interface User {
  id: string;
  login: string;
  name: string | null;
}
/** A way to sign in: a GitHub account (numeric id) or a Linear user (UUID). */
export type Identity =
  | { provider: 'github'; id: number }
  | { provider: 'linear'; id: string };
export interface Team {
  id: string;
  name: string;
  createdAt: string;
}
export interface Member {
  user: User;
  role: 'admin' | 'member';
  joinedAt: string;
}
export interface Device {
  id: string;
  userId: string;
  teamId: string;
  client: string;
  lastSeen: string | null;
}

function hashOf(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function secret(): string {
  return randomBytes(32).toString('base64url');
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

/** A GitHub login or Linear display name as a Dispatch handle: lowercase,
 * handle characters only. */
export function handleOf(login: string): string {
  return login
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 39);
}

export class TeamDb {
  readonly db: Database;

  constructor(
    path: string,
    private readonly now: () => Date = () => new Date()
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.addLinearIdentity();
    this.addInviteColumns();
  }

  // Columns added after the tables shipped: the address an invite was
  // emailed to, and the invite a device sign-in carries (`dispatch-mcp join`).
  private addInviteColumns(): void {
    const has = (table: string, column: string) =>
      this.db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .some((c) => c.name === column);
    if (!has('invites', 'email'))
      this.db.exec('ALTER TABLE invites ADD COLUMN email TEXT');
    if (!has('device_codes', 'invite_hash'))
      this.db.exec('ALTER TABLE device_codes ADD COLUMN invite_hash TEXT');
  }

  // Databases written before Linear sign-in have no linear_user_id. SQLite
  // cannot add a UNIQUE column, so the column and its unique index are separate.
  private addLinearIdentity(): void {
    const columns = this.db
      .query<{ name: string }, []>('PRAGMA table_info(users)')
      .all();
    if (!columns.some((c) => c.name === 'linear_user_id'))
      this.db.exec('ALTER TABLE users ADD COLUMN linear_user_id TEXT');
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS users_linear_user_id ON users (linear_user_id)'
    );
  }

  close(): void {
    this.db.close();
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  // ---- users and browser sessions ----

  /** The user for a GitHub account, created on first sign-in. */
  upsertGithubUser(githubId: number, login: string, name: string | null): User {
    const existing = this.db
      .query<{ id: string }, [number]>(
        'SELECT id FROM users WHERE github_id = ?'
      )
      .get(githubId);
    // A handle is someone's agent addresses (agent:<handle>/...), so it is
    // fixed at first sign-in and never handed on: a GitHub rename keeps the
    // old handle, and a newcomer whose login is taken gets a suffixed one.
    if (existing !== null) {
      this.db
        .query('UPDATE users SET name = ? WHERE id = ?')
        .run(name, existing.id);
      return this.user(existing.id)!;
    }
    const handle = this.freeHandle(login, String(githubId));
    const user: User = { id: id('usr'), login: handle, name };
    this.db
      .query(
        'INSERT INTO users (id, github_id, login, name, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(user.id, githubId, handle, name, this.iso());
    return user;
  }

  /** The user for a Linear account, created on first sign-in. */
  upsertLinearUser(
    linearId: string,
    displayName: string,
    name: string | null
  ): User {
    const existing = this.db
      .query<{ id: string }, [string]>(
        'SELECT id FROM users WHERE linear_user_id = ?'
      )
      .get(linearId);
    if (existing !== null) {
      this.db
        .query('UPDATE users SET name = ? WHERE id = ?')
        .run(name, existing.id);
      return this.user(existing.id)!;
    }
    // Linear ids are UUIDs, too long for a readable suffix: a taken handle
    // gets a random one instead.
    const user: User = {
      id: id('usr'),
      login: this.freeHandle(displayName, null),
      name,
    };
    this.db
      .query(
        'INSERT INTO users (id, linear_user_id, login, name, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(user.id, linearId, user.login, name, this.iso());
    return user;
  }

  /**
   * Adds a GitHub or Linear identity to an existing account. Refused, naming
   * the holder, when another account already signs in with it: accounts are
   * never merged here.
   */
  linkIdentity(
    userId: string,
    identity: Identity
  ): { ok: true } | { ok: false; owner: User } {
    const column =
      identity.provider === 'github' ? 'github_id' : 'linear_user_id';
    const holder = this.db
      .query<{ id: string }, [string | number]>(
        `SELECT id FROM users WHERE ${column} = ?`
      )
      .get(identity.id);
    if (holder !== null && holder.id !== userId)
      return { ok: false, owner: this.user(holder.id)! };
    this.db
      .query(`UPDATE users SET ${column} = ? WHERE id = ?`)
      .run(identity.id, userId);
    return { ok: true };
  }

  /** Which providers an account can sign in with. */
  identities(userId: string): { github: boolean; linear: boolean } {
    const row = this.db
      .query<
        { github_id: number | null; linear_user_id: string | null },
        [string]
      >('SELECT github_id, linear_user_id FROM users WHERE id = ?')
      .get(userId);
    return {
      github: row?.github_id != null,
      linear: row?.linear_user_id != null,
    };
  }

  // A handle is someone's agent addresses (agent:<handle>/...), so a newcomer
  // whose wanted handle is taken gets a suffixed one: `preferredSuffix` first
  // when given, then random ones (a suffixed handle can be a real login too).
  private freeHandle(wanted: string, preferredSuffix: string | null): string {
    const taken = (h: string): boolean =>
      this.db.query('SELECT 1 FROM users WHERE login = ?').get(h) !== null;
    const derived = handleOf(wanted);
    const base = derived === '' ? 'user' : derived;
    let handle = base;
    if (taken(handle) && preferredSuffix !== null)
      handle = `${base.slice(0, 28)}-${preferredSuffix}`;
    while (taken(handle))
      handle = `${base.slice(0, 28)}-${randomBytes(3).toString('hex')}`;
    return handle;
  }

  user(userId: string): User | null {
    return (
      this.db
        .query<User, [string]>('SELECT id, login, name FROM users WHERE id = ?')
        .get(userId) ?? null
    );
  }

  /** Starts a browser session; returns its cookie value. */
  startWebSession(userId: string): string {
    const value = secret();
    this.db
      .query(
        'INSERT INTO web_sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)'
      )
      .run(hashOf(value), userId, this.iso(WEB_SESSION_DAYS * 86_400_000));
    return value;
  }

  webSessionUser(value: string): User | null {
    const row = this.db
      .query<{ user_id: string; expires_at: string }, [string]>(
        'SELECT user_id, expires_at FROM web_sessions WHERE id_hash = ?'
      )
      .get(hashOf(value));
    if (row === null || row.expires_at < this.iso()) return null;
    return this.user(row.user_id);
  }

  endWebSession(value: string): void {
    this.db
      .query('DELETE FROM web_sessions WHERE id_hash = ?')
      .run(hashOf(value));
  }

  // ---- teams, members, invites ----

  createTeam(name: string, founder: string): Team {
    const team: Team = { id: id('team'), name, createdAt: this.iso() };
    this.db.transaction(() => {
      this.db
        .query(
          'INSERT INTO teams (id, name, created_by, created_at) VALUES (?, ?, ?, ?)'
        )
        .run(team.id, name, founder, team.createdAt);
      this.db
        .query(
          "INSERT INTO members (team_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)"
        )
        .run(team.id, founder, team.createdAt);
    })();
    return team;
  }

  team(teamId: string): Team | null {
    return (
      this.db
        .query<Team, [string]>(
          'SELECT id, name, created_at AS createdAt FROM teams WHERE id = ?'
        )
        .get(teamId) ?? null
    );
  }

  teamsOf(userId: string): (Team & { role: string })[] {
    return this.db
      .query<Team & { role: string }, [string]>(
        `SELECT t.id, t.name, t.created_at AS createdAt, m.role FROM teams t
         JOIN members m ON m.team_id = t.id WHERE m.user_id = ? ORDER BY t.created_at`
      )
      .all(userId);
  }

  role(teamId: string, userId: string): 'admin' | 'member' | null {
    const row = this.db
      .query<{ role: string }, [string, string]>(
        'SELECT role FROM members WHERE team_id = ? AND user_id = ?'
      )
      .get(teamId, userId);
    return row === null ? null : (row.role as 'admin' | 'member');
  }

  members(teamId: string): Member[] {
    return this.db
      .query<
        {
          id: string;
          login: string;
          name: string | null;
          role: string;
          joined_at: string;
        },
        [string]
      >(
        `SELECT u.id, u.login, u.name, m.role, m.joined_at FROM members m
         JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY m.joined_at`
      )
      .all(teamId)
      .map((r) => ({
        user: { id: r.id, login: r.login, name: r.name },
        role: r.role as 'admin' | 'member',
        joinedAt: r.joined_at,
      }));
  }

  /** An invite link's secret, for an admin of the team; `email` is where it
   *  was sent, kept so the team page can list who is still to join. */
  createInvite(
    teamId: string,
    by: string,
    email: string | null = null
  ): string {
    const token = secret();
    this.db
      .query(
        'INSERT INTO invites (token_hash, team_id, created_by, expires_at, email) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        hashOf(token),
        teamId,
        by,
        this.iso(INVITE_DAYS * 86_400_000),
        email
      );
    return token;
  }

  /** The team an unused, unexpired invite is for. */
  inviteTeam(token: string): Team | null {
    return this.inviteTeamByHash(hashOf(token), null);
  }

  // The team an invite (by its hash) admits `userId` to: unused and
  // unexpired, or already used by that same person, so following the link
  // and then running `dispatch-mcp join` with it both work.
  private inviteTeamByHash(hash: string, userId: string | null): Team | null {
    const row = this.db
      .query<
        { team_id: string; expires_at: string; used_by: string | null },
        [string]
      >('SELECT team_id, expires_at, used_by FROM invites WHERE token_hash = ?')
      .get(hash);
    if (row === null || row.expires_at < this.iso()) return null;
    if (row.used_by !== null && row.used_by !== userId) return null;
    return this.team(row.team_id);
  }

  /** Invites not yet used or expired, newest first, for the team page. */
  openInvites(
    teamId: string
  ): { email: string | null; expiresAt: string; createdAt: string }[] {
    return this.db
      .query<{ email: string | null; expires_at: string }, [string, string]>(
        `SELECT email, expires_at FROM invites
         WHERE team_id = ? AND used_by IS NULL AND expires_at >= ?
         ORDER BY expires_at DESC`
      )
      .all(teamId, this.iso())
      .map((r) => ({
        email: r.email,
        expiresAt: r.expires_at,
        createdAt: new Date(
          new Date(r.expires_at).getTime() - INVITE_DAYS * 86_400_000
        ).toISOString(),
      }));
  }

  /** Uses an invite to join its team; why not, when it cannot. Using it a
   *  second time, as the person who already did, is a no-op success. */
  acceptInvite(
    token: string,
    userId: string
  ): { ok: true; team: Team } | { ok: false; reason: string } {
    return this.acceptInviteByHash(hashOf(token), userId);
  }

  private acceptInviteByHash(
    hash: string,
    userId: string
  ): { ok: true; team: Team } | { ok: false; reason: string } {
    return this.db.transaction(() => {
      const team = this.inviteTeamByHash(hash, userId);
      if (team === null)
        return {
          ok: false as const,
          reason: 'this invite is used, expired or unknown',
        };
      if (this.role(team.id, userId) !== null)
        return { ok: true as const, team };
      if (this.members(team.id).length >= FREE_SEATS)
        return {
          ok: false as const,
          reason: `${team.name} has all ${FREE_SEATS} free seats taken`,
        };
      this.db
        .query('UPDATE invites SET used_by = ? WHERE token_hash = ?')
        .run(userId, hash);
      this.db
        .query(
          "INSERT INTO members (team_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)"
        )
        .run(team.id, userId, this.iso());
      return { ok: true as const, team };
    })();
  }

  /** Records that the person signed in to Linear as a member of `org`, so a
   *  team linked to that workspace can offer them a Join button. */
  noteLinearOrg(userId: string, org: { id: string; name: string }): void {
    this.db
      .query(
        `INSERT INTO linear_orgs (user_id, org_id, org_name, seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, org_id) DO UPDATE SET org_name = excluded.org_name, seen_at = excluded.seen_at`
      )
      .run(userId, org.id, org.name, this.iso());
  }

  /** The Linear workspaces the person was seen in within `withinDays`. */
  linearOrgsOf(userId: string, withinDays = 30): string[] {
    return this.db
      .query<{ org_id: string }, [string, string]>(
        'SELECT org_id FROM linear_orgs WHERE user_id = ? AND seen_at >= ?'
      )
      .all(userId, this.iso(-withinDays * 86_400_000))
      .map((r) => r.org_id);
  }

  /** Adds a member without an invite: a person the caller has checked may
   *  join (a member of the Linear workspace the team is linked to). */
  addMember(
    teamId: string,
    userId: string
  ): { ok: true; team: Team } | { ok: false; reason: string } {
    return this.db.transaction(() => {
      const team = this.team(teamId);
      if (team === null) return { ok: false as const, reason: 'no such team' };
      if (this.role(teamId, userId) !== null)
        return { ok: true as const, team };
      if (this.members(teamId).length >= FREE_SEATS)
        return {
          ok: false as const,
          reason: `${team.name} has all ${FREE_SEATS} free seats taken`,
        };
      this.db
        .query(
          "INSERT INTO members (team_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)"
        )
        .run(teamId, userId, this.iso());
      return { ok: true as const, team };
    })();
  }

  /** Removes a member and signs out every one of their devices on the team. */
  removeMember(teamId: string, userId: string): void {
    this.db.transaction(() => {
      this.db
        .query('DELETE FROM members WHERE team_id = ? AND user_id = ?')
        .run(teamId, userId);
      this.db
        .query(
          'UPDATE devices SET revoked = 1 WHERE team_id = ? AND user_id = ?'
        )
        .run(teamId, userId);
    })();
  }

  // ---- device sign-in (RFC 8628) ----

  startDeviceCode(
    client: string,
    invite: string | null = null
  ): {
    deviceCode: string;
    userCode: string;
    expiresIn: number;
  } {
    const deviceCode = secret();
    const bytes = randomBytes(8);
    let userCode = '';
    for (let i = 0; i < 8; i++) {
      userCode +=
        USER_CODE_ALPHABET[(bytes[i] ?? 0) % USER_CODE_ALPHABET.length];
      if (i === 3) userCode += '-';
    }
    this.db
      .query(
        'INSERT INTO device_codes (device_hash, user_code, client, expires_at, invite_hash) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        hashOf(deviceCode),
        userCode,
        client.slice(0, 100),
        this.iso(DEVICE_CODE_MINUTES * 60_000),
        invite === null ? null : hashOf(invite)
      );
    return { deviceCode, userCode, expiresIn: DEVICE_CODE_MINUTES * 60 };
  }

  /** A pending sign-in by the code its person typed, for the approval page;
   *  `invite` is the team the sign-in's invite (if any) lets `userId` join. */
  pendingDevice(
    userCode: string,
    userId: string | null = null
  ): { client: string; invite: Team | null } | null {
    const row = this.db
      .query<
        {
          client: string;
          expires_at: string;
          user_id: string | null;
          denied: number;
          invite_hash: string | null;
        },
        [string]
      >(
        'SELECT client, expires_at, user_id, denied, invite_hash FROM device_codes WHERE user_code = ?'
      )
      .get(normalCode(userCode));
    if (
      row === null ||
      row.expires_at < this.iso() ||
      row.user_id !== null ||
      row.denied === 1
    )
      return null;
    return {
      client: row.client,
      invite:
        row.invite_hash === null
          ? null
          : this.inviteTeamByHash(row.invite_hash, userId),
    };
  }

  /** The signed-in person approves a code for one of their teams. A code
   *  that carries an invite to `teamId` joins them to it first, so a
   *  teammate's one command (`dispatch-mcp join <link>`) and one click in
   *  the browser both join the team and sign the machine in. */
  approveDevice(userCode: string, userId: string, teamId: string): boolean {
    return this.approveDeviceFor(userCode, userId, teamId).ok;
  }

  /** approveDevice, saying why not when it cannot. */
  approveDeviceFor(
    userCode: string,
    userId: string,
    teamId: string
  ): { ok: true } | { ok: false; reason: string } {
    const pending = this.pendingDevice(userCode, userId);
    if (pending === null)
      return { ok: false, reason: 'That code is not waiting for a sign-in.' };
    if (this.role(teamId, userId) === null) {
      const hash = this.db
        .query<{ invite_hash: string | null }, [string]>(
          'SELECT invite_hash FROM device_codes WHERE user_code = ?'
        )
        .get(normalCode(userCode))?.invite_hash;
      if (pending.invite?.id !== teamId || hash == null)
        return { ok: false, reason: 'You are not in that team.' };
      const joined = this.acceptInviteByHash(hash, userId);
      if (!joined.ok) return joined;
    }
    this.db
      .query(
        'UPDATE device_codes SET user_id = ?, team_id = ? WHERE user_code = ?'
      )
      .run(userId, teamId, normalCode(userCode));
    return { ok: true };
  }

  denyDevice(userCode: string): void {
    this.db
      .query('UPDATE device_codes SET denied = 1 WHERE user_code = ?')
      .run(normalCode(userCode));
  }

  /** The device's poll: pending, denied, expired, or (once) its credential. */
  claimDevice(
    deviceCode: string
  ):
    | { status: 'pending' | 'denied' | 'expired' }
    | { status: 'ok'; token: string; device: Device; user: User; team: Team } {
    return this.db.transaction(() => {
      const row = this.db
        .query<
          {
            client: string;
            expires_at: string;
            user_id: string | null;
            team_id: string | null;
            denied: number;
            claimed: number;
          },
          [string]
        >(
          'SELECT client, expires_at, user_id, team_id, denied, claimed FROM device_codes WHERE device_hash = ?'
        )
        .get(hashOf(deviceCode));
      if (row === null || row.claimed === 1 || row.expires_at < this.iso())
        return { status: 'expired' as const };
      if (row.denied === 1) return { status: 'denied' as const };
      if (row.user_id === null || row.team_id === null)
        return { status: 'pending' as const };
      this.db
        .query('UPDATE device_codes SET claimed = 1 WHERE device_hash = ?')
        .run(hashOf(deviceCode));
      const token = secret();
      const device: Device = {
        id: id('dev'),
        userId: row.user_id,
        teamId: row.team_id,
        client: row.client,
        lastSeen: null,
      };
      this.db
        .query(
          'INSERT INTO devices (id, token_hash, user_id, team_id, client, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(
          device.id,
          hashOf(token),
          device.userId,
          device.teamId,
          device.client,
          this.iso()
        );
      return {
        status: 'ok' as const,
        token,
        device,
        user: this.user(row.user_id)!,
        team: this.team(row.team_id)!,
      };
    })();
  }

  /** The live device a credential belongs to, if its owner is still a member. */
  deviceByToken(token: string): Device | null {
    const row = this.db
      .query<
        {
          id: string;
          user_id: string;
          team_id: string;
          client: string;
          last_seen: string | null;
          revoked: number;
        },
        [string]
      >(
        'SELECT id, user_id, team_id, client, last_seen, revoked FROM devices WHERE token_hash = ?'
      )
      .get(hashOf(token));
    if (
      row === null ||
      row.revoked === 1 ||
      this.role(row.team_id, row.user_id) === null
    )
      return null;
    return {
      id: row.id,
      userId: row.user_id,
      teamId: row.team_id,
      client: row.client,
      lastSeen: row.last_seen,
    };
  }

  /** Whether a device is still signed in and its owner still a member. */
  deviceLive(deviceId: string): boolean {
    const row = this.db
      .query<{ user_id: string; team_id: string; revoked: number }, [string]>(
        'SELECT user_id, team_id, revoked FROM devices WHERE id = ?'
      )
      .get(deviceId);
    return (
      row !== null &&
      row.revoked === 0 &&
      this.role(row.team_id, row.user_id) !== null
    );
  }

  touchDevice(deviceId: string): void {
    this.db
      .query('UPDATE devices SET last_seen = ? WHERE id = ?')
      .run(this.iso(), deviceId);
  }

  devicesOf(teamId: string): (Device & { login: string })[] {
    return this.db
      .query<
        {
          id: string;
          user_id: string;
          team_id: string;
          client: string;
          last_seen: string | null;
          login: string;
        },
        [string]
      >(
        `SELECT d.id, d.user_id, d.team_id, d.client, d.last_seen, u.login FROM devices d
         JOIN users u ON u.id = d.user_id WHERE d.team_id = ? AND d.revoked = 0 ORDER BY d.created_at`
      )
      .all(teamId)
      .map((r) => ({
        id: r.id,
        userId: r.user_id,
        teamId: r.team_id,
        client: r.client,
        lastSeen: r.last_seen,
        login: r.login,
      }));
  }

  /** A person's own signed-in machines, across their teams, newest first. */
  devicesOfUser(userId: string): (Device & { teamName: string })[] {
    return this.db
      .query<
        {
          id: string;
          user_id: string;
          team_id: string;
          client: string;
          last_seen: string | null;
          team_name: string;
        },
        [string]
      >(
        `SELECT d.id, d.user_id, d.team_id, d.client, d.last_seen, t.name AS team_name
         FROM devices d JOIN teams t ON t.id = d.team_id
         WHERE d.user_id = ? AND d.revoked = 0 ORDER BY d.created_at DESC`
      )
      .all(userId)
      .map((r) => ({
        id: r.id,
        userId: r.user_id,
        teamId: r.team_id,
        client: r.client,
        lastSeen: r.last_seen,
        teamName: r.team_name,
      }));
  }

  /** Records the replica id a device's machine hub links as, kept while it
   *  is offline; false when another device on the team already has it. */
  setDeviceReplica(deviceId: string, replica: string): boolean {
    const taken = this.db
      .query<{ id: string }, [string, string, string]>(
        `SELECT d.id FROM devices d JOIN devices me ON me.id = ?
         WHERE d.team_id = me.team_id AND d.hub_replica = ? AND d.id <> ? AND d.revoked = 0`
      )
      .get(deviceId, replica, deviceId);
    if (taken !== null) return false;
    this.db
      .query('UPDATE devices SET hub_replica = ? WHERE id = ?')
      .run(replica, deviceId);
    return true;
  }

  deviceReplica(deviceId: string): string | null {
    return (
      this.db
        .query<{ hub_replica: string | null }, [string]>(
          'SELECT hub_replica FROM devices WHERE id = ?'
        )
        .get(deviceId)?.hub_replica ?? null
    );
  }

  revokeDevice(deviceId: string): void {
    this.db.query('UPDATE devices SET revoked = 1 WHERE id = ?').run(deviceId);
  }
}

// ---- OAuth for the hosted MCP endpoint ----

const ACCESS_SECONDS = 3600;
const CODE_SECONDS = 300;

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
}

/** A grant behind an access token: who, on which team, through which client. */
export interface Grant {
  id: string;
  clientId: string;
  user: User;
  teamId: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export class OAuthDb {
  constructor(
    private readonly teams: TeamDb,
    private readonly now: () => Date = () => new Date()
  ) {}

  private get db(): Database {
    return this.teams.db;
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  registerClient(name: string, redirectUris: string[]): OAuthClient {
    const client = { id: id('cli'), name: name.slice(0, 100), redirectUris };
    this.db
      .query(
        'INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)'
      )
      .run(client.id, client.name, JSON.stringify(redirectUris), this.iso());
    return client;
  }

  client(clientId: string): OAuthClient | null {
    const row = this.db
      .query<{ id: string; name: string; redirect_uris: string }, [string]>(
        'SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ?'
      )
      .get(clientId);
    return row === null
      ? null
      : {
          id: row.id,
          name: row.name,
          redirectUris: JSON.parse(row.redirect_uris) as string[],
        };
  }

  issueCode(input: {
    clientId: string;
    userId: string;
    teamId: string;
    redirectUri: string;
    challenge: string;
  }): string {
    const code = secret();
    this.db
      .query(
        'INSERT INTO oauth_codes (code_hash, client_id, user_id, team_id, redirect_uri, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        hashOf(code),
        input.clientId,
        input.userId,
        input.teamId,
        input.redirectUri,
        input.challenge,
        this.iso(CODE_SECONDS * 1000)
      );
    return code;
  }

  /** Redeems a code once, for the client and redirect it was issued to, with
   *  the PKCE verifier whose S256 hash it was bound to. */
  redeemCode(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    verifier: string;
  }): OAuthTokens | null {
    return this.db.transaction(() => {
      const row = this.db
        .query<
          {
            client_id: string;
            user_id: string;
            team_id: string;
            redirect_uri: string;
            challenge: string;
            expires_at: string;
            used: number;
          },
          [string]
        >(
          'SELECT client_id, user_id, team_id, redirect_uri, challenge, expires_at, used FROM oauth_codes WHERE code_hash = ?'
        )
        .get(hashOf(input.code));
      if (row === null || row.used === 1 || row.expires_at < this.iso())
        return null;
      this.db
        .query('UPDATE oauth_codes SET used = 1 WHERE code_hash = ?')
        .run(hashOf(input.code));
      const challenge = createHash('sha256')
        .update(input.verifier)
        .digest('base64url');
      if (
        row.client_id !== input.clientId ||
        row.redirect_uri !== input.redirectUri ||
        row.challenge !== challenge
      )
        return null;
      if (this.teams.role(row.team_id, row.user_id) === null) return null;
      return this.newGrant(row.client_id, row.user_id, row.team_id);
    })();
  }

  /** Rotates a refresh token: the old one stops working. */
  refresh(refreshToken: string, clientId: string): OAuthTokens | null {
    return this.db.transaction(() => {
      const row = this.db
        .query<
          {
            id: string;
            client_id: string;
            user_id: string;
            team_id: string;
            revoked: number;
          },
          [string]
        >(
          'SELECT id, client_id, user_id, team_id, revoked FROM oauth_grants WHERE refresh_hash = ?'
        )
        .get(hashOf(refreshToken));
      if (row === null || row.revoked === 1 || row.client_id !== clientId)
        return null;
      if (this.teams.role(row.team_id, row.user_id) === null) return null;
      const access = secret();
      const refresh = secret();
      this.db
        .query(
          'UPDATE oauth_grants SET access_hash = ?, access_expires_at = ?, refresh_hash = ? WHERE id = ?'
        )
        .run(
          hashOf(access),
          this.iso(ACCESS_SECONDS * 1000),
          hashOf(refresh),
          row.id
        );
      return {
        accessToken: access,
        refreshToken: refresh,
        expiresIn: ACCESS_SECONDS,
      };
    })();
  }

  /** The live grant an access token belongs to. */
  grant(accessToken: string): Grant | null {
    const row = this.db
      .query<
        {
          id: string;
          client_id: string;
          user_id: string;
          team_id: string;
          access_expires_at: string;
          revoked: number;
        },
        [string]
      >(
        'SELECT id, client_id, user_id, team_id, access_expires_at, revoked FROM oauth_grants WHERE access_hash = ?'
      )
      .get(hashOf(accessToken));
    if (row === null || row.revoked === 1 || row.access_expires_at < this.iso())
      return null;
    if (this.teams.role(row.team_id, row.user_id) === null) return null;
    const user = this.teams.user(row.user_id);
    return user === null
      ? null
      : { id: row.id, clientId: row.client_id, user, teamId: row.team_id };
  }

  private newGrant(
    clientId: string,
    userId: string,
    teamId: string
  ): OAuthTokens {
    const access = secret();
    const refresh = secret();
    this.db
      .query(
        'INSERT INTO oauth_grants (id, client_id, user_id, team_id, access_hash, access_expires_at, refresh_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id('grant'),
        clientId,
        userId,
        teamId,
        hashOf(access),
        this.iso(ACCESS_SECONDS * 1000),
        hashOf(refresh),
        this.iso()
      );
    return {
      accessToken: access,
      refreshToken: refresh,
      expiresIn: ACCESS_SECONDS,
    };
  }
}

// A typed code, forgiving case, spaces and a missing dash.
function normalCode(code: string): string {
  const letters = code.toUpperCase().replace(/[^A-Z]/g, '');
  return letters.length === 8
    ? `${letters.slice(0, 4)}-${letters.slice(4)}`
    : code.toUpperCase();
}
