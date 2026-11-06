import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TeamDb } from '../src/db.js';

// One Dispatch account can carry a GitHub identity, a Linear identity or both.

let db: TeamDb;
afterEach(() => db.close());

describe('TeamDb identities', () => {
  it('creates one account per Linear user and finds it again', () => {
    db = new TeamDb(':memory:');
    const first = db.upsertLinearUser('lin-1', 'Grace.H', 'Grace Hopper');
    expect(first.login).toBe('grace.h');
    expect(first.name).toBe('Grace Hopper');
    const again = db.upsertLinearUser('lin-1', 'renamed', 'Grace B. Hopper');
    expect(again.id).toBe(first.id);
    // The handle is fixed at first sign-in, as for GitHub.
    expect(again.login).toBe('grace.h');
    expect(again.name).toBe('Grace B. Hopper');
    expect(db.identities(first.id)).toEqual({ github: false, linear: true });
  });

  it('gives a Linear newcomer a fresh handle when a GitHub user holds theirs', () => {
    db = new TeamDb(':memory:');
    const gh = db.upsertGithubUser(7, 'ada', null);
    const lin = db.upsertLinearUser('lin-ada', 'ada', null);
    expect(lin.id).not.toBe(gh.id);
    expect(lin.login).not.toBe('ada');
    expect(lin.login.startsWith('ada-')).toBe(true);
  });

  it('links the other provider to an account, once', () => {
    db = new TeamDb(':memory:');
    const ada = db.upsertGithubUser(7, 'ada', null);
    expect(
      db.linkIdentity(ada.id, { provider: 'linear', id: 'lin-ada' })
    ).toEqual({ ok: true });
    expect(db.identities(ada.id)).toEqual({ github: true, linear: true });
    expect(db.upsertLinearUser('lin-ada', 'whatever', null).id).toBe(ada.id);

    const grace = db.upsertLinearUser('lin-grace', 'grace', null);
    expect(db.linkIdentity(grace.id, { provider: 'github', id: 9 })).toEqual({
      ok: true,
    });
    expect(db.upsertGithubUser(9, 'grace-gh', null).id).toBe(grace.id);
  });

  it('refuses to link an identity another account already holds', () => {
    db = new TeamDb(':memory:');
    const ada = db.upsertGithubUser(7, 'ada', null);
    const grace = db.upsertLinearUser('lin-grace', 'grace', null);
    expect(
      db.linkIdentity(ada.id, { provider: 'linear', id: 'lin-grace' })
    ).toEqual({
      ok: false,
      owner: grace,
    });
    expect(db.identities(ada.id)).toEqual({ github: true, linear: false });
    // Linking the same identity to its own account is a no-op success.
    expect(
      db.linkIdentity(grace.id, { provider: 'linear', id: 'lin-grace' })
    ).toEqual({ ok: true });
  });

  it('adds the Linear column to a database written before it existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-db-'));
    try {
      const path = join(dir, 'team.db');
      const old = new Database(path, { create: true });
      old.exec(
        'CREATE TABLE users (id TEXT PRIMARY KEY, github_id INTEGER UNIQUE, login TEXT NOT NULL UNIQUE, name TEXT, created_at TEXT NOT NULL)'
      );
      old.exec(
        "INSERT INTO users VALUES ('usr_old', 7, 'ada', null, '2026-10-15T00:00:00Z')"
      );
      old.close();
      db = new TeamDb(path);
      expect(db.user('usr_old')?.login).toBe('ada');
      expect(
        db.linkIdentity('usr_old', { provider: 'linear', id: 'lin-ada' })
      ).toEqual({ ok: true });
      expect(db.upsertLinearUser('lin-ada', 'x', null).id).toBe('usr_old');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
