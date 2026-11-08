import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { FREE_SEATS, TeamDb } from '../src/db.js';

let db: TeamDb;
let clock: number;
beforeEach(() => {
  clock = Date.parse('2026-10-15T00:00:00Z');
  db = new TeamDb(':memory:', () => new Date(clock));
});
afterEach(() => db.close());

describe('TeamDb', () => {
  it('creates a team with its founder as admin and fills seats by invite', () => {
    const ada = db.upsertGithubUser(1, 'Ada', 'Ada L');
    expect(ada.login).toBe('ada');
    const team = db.createTeam('Core', ada.id);
    expect(db.role(team.id, ada.id)).toBe('admin');

    for (let i = 2; i <= FREE_SEATS; i++) {
      const u = db.upsertGithubUser(i, `user${i}`, null);
      expect(db.acceptInvite(db.createInvite(team.id, ada.id), u.id).ok).toBe(
        true
      );
    }
    const extra = db.upsertGithubUser(99, 'late', null);
    const full = db.acceptInvite(db.createInvite(team.id, ada.id), extra.id);
    expect(full).toEqual({
      ok: false,
      reason: expect.stringContaining('free seats'),
    });
  });

  it('uses an invite once and refuses it expired', () => {
    const ada = db.upsertGithubUser(1, 'ada', null);
    const bob = db.upsertGithubUser(2, 'bob', null);
    const cy = db.upsertGithubUser(3, 'cy', null);
    const team = db.createTeam('Core', ada.id);
    const invite = db.createInvite(team.id, ada.id);
    expect(db.acceptInvite(invite, bob.id).ok).toBe(true);
    expect(db.acceptInvite(invite, cy.id).ok).toBe(false);
    const late = db.createInvite(team.id, ada.id);
    clock += 8 * 86_400_000;
    expect(db.acceptInvite(late, cy.id).ok).toBe(false);
  });

  it('signs a device in through a typed code, once', () => {
    const ada = db.upsertGithubUser(1, 'ada', null);
    const team = db.createTeam('Core', ada.id);
    const { deviceCode, userCode } = db.startDeviceCode('dispatch-mcp');
    expect(db.claimDevice(deviceCode).status).toBe('pending');
    expect(db.pendingDevice(userCode.toLowerCase().replace('-', ' '))).toEqual({
      client: 'dispatch-mcp',
    });
    expect(db.approveDevice(userCode, ada.id, team.id)).toBe(true);
    const claimed = db.claimDevice(deviceCode);
    if (claimed.status !== 'ok') throw new Error(claimed.status);
    expect(claimed.user.login).toBe('ada');
    expect(db.deviceByToken(claimed.token)?.teamId).toBe(team.id);
    expect(db.claimDevice(deviceCode).status).toBe('expired');
  });

  it('refuses approval for a team the person is not in, and expires codes', () => {
    const ada = db.upsertGithubUser(1, 'ada', null);
    const bob = db.upsertGithubUser(2, 'bob', null);
    const team = db.createTeam('Core', ada.id);
    const { deviceCode, userCode } = db.startDeviceCode('x');
    expect(db.approveDevice(userCode, bob.id, team.id)).toBe(false);
    clock += 16 * 60_000;
    expect(db.claimDevice(deviceCode).status).toBe('expired');
  });

  it('signs out a removed member’s devices', () => {
    const ada = db.upsertGithubUser(1, 'ada', null);
    const bob = db.upsertGithubUser(2, 'bob', null);
    const team = db.createTeam('Core', ada.id);
    db.acceptInvite(db.createInvite(team.id, ada.id), bob.id);
    const { deviceCode, userCode } = db.startDeviceCode('x');
    db.approveDevice(userCode, bob.id, team.id);
    const c = db.claimDevice(deviceCode);
    if (c.status !== 'ok') throw new Error(c.status);
    db.removeMember(team.id, bob.id);
    expect(db.deviceByToken(c.token)).toBeNull();
  });
});

describe('device replicas', () => {
  it('keeps a replica id to one device on a team', () => {
    const ada = db.upsertGithubUser(1, 'ada', null);
    const team = db.createTeam('Core', ada.id);
    const device = () => {
      const { deviceCode, userCode } = db.startDeviceCode('x');
      db.approveDevice(userCode, ada.id, team.id);
      const c = db.claimDevice(deviceCode);
      if (c.status !== 'ok') throw new Error(c.status);
      return c.device.id;
    };
    const first = device();
    const second = device();
    expect(db.setDeviceReplica(first, '@hub-00000001')).toBe(true);
    expect(db.setDeviceReplica(second, '@hub-00000001')).toBe(false);
    expect(db.setDeviceReplica(first, '@hub-00000001')).toBe(true);
    expect(db.deviceReplica(first)).toBe('@hub-00000001');
  });
});

describe('GitHub renames', () => {
  it('never hands a handle on: a newcomer with a taken login gets its own', () => {
    const old = db.upsertGithubUser(1, 'sam', null);
    const fresh = db.upsertGithubUser(2, 'sam', null);
    expect(db.user(old.id)?.login).toBe('sam');
    expect(fresh.login).toBe('sam-2');
    // A rename on GitHub keeps the handle someone already has.
    expect(db.upsertGithubUser(1, 'samuel', 'Sam').login).toBe('sam');
    // Even when the suffixed handle is someone's real login, sign-in works.
    db.upsertGithubUser(3, 'sam-4', null);
    const fourth = db.upsertGithubUser(4, 'sam', null);
    expect(fourth.login).toMatch(/^sam-[0-9a-f]{6}$/);
  });
});
