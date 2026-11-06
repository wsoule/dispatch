import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TeamDb } from '../src/db.js';
import { TeamHub } from '../src/hub.js';

// A team hub opened after a machine signed out does not list its agents.

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('TeamHub', () => {
  it('drops the agents of machines signed out before it opened', () => {
    dir = mkdtempSync(join(tmpdir(), 'team-hub-'));
    const db = new TeamDb(':memory:');
    const ada = db.upsertGithubUser(1, 'ada', null);
    const team = db.createTeam('Core', ada.id);
    const { deviceCode, userCode } = db.startDeviceCode('x');
    db.approveDevice(userCode, ada.id, team.id);
    const c = db.claimDevice(deviceCode);
    if (c.status !== 'ok') throw new Error(c.status);

    const first = new TeamHub(team.id, dir, db);
    first.store.putAgent({
      address: 'agent:ada/codex-aaaaaa',
      displayName: 'codex-aaaaaa',
      client: 'codex',
      tokenHash: `dev:${c.device.id}:abc`,
      status: 'approved',
      muted: false,
      approvedBy: 'human:ada',
      createdAt: new Date().toISOString(),
      parent: 'agent:ada/codex.mac',
    });
    first.close();
    db.revokeDevice(c.device.id);

    const reopened = new TeamHub(team.id, dir, db);
    expect(reopened.store.getAgent('agent:ada/codex-aaaaaa')).toBeNull();
    expect(reopened.sessions()).toEqual([]);
    reopened.close();
    db.close();
  });
});
