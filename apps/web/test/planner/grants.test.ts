import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TeamDb } from '../../src/db.js';
import { Sealer } from '../../src/linear.js';
import { GrantGone, LinearGrants } from '../../src/planner/grants.js';

// Each person's read grant on a Linear workspace: sealed at rest, refreshed
// before it expires, dropped when Linear revokes it.

let db: TeamDb;
let clock: number;
let refreshes: URLSearchParams[];
let refreshAnswer: () => Response;
let grants: LinearGrants;

const ORG = { id: 'org-1', name: 'Acme', urlKey: 'acme' };
const fakeFetch = ((_url: string | URL | Request, init?: RequestInit) => {
  refreshes.push(
    new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
  );
  return Promise.resolve(refreshAnswer());
}) as typeof fetch;

beforeEach(() => {
  clock = Date.parse('2026-11-06T12:00:00Z');
  db = new TeamDb(':memory:');
  refreshes = [];
  refreshAnswer = () =>
    Response.json({
      access_token: 'lin_oauth_new_access',
      refresh_token: 'new-refresh',
      expires_in: 86_399,
    });
  grants = new LinearGrants(
    db.db,
    new Sealer('secret'),
    'lin-client',
    fakeFetch,
    () => clock
  );
});
afterEach(() => db.close());

const save = (userId = 'usr_ada', linearUserId = 'lin-ada') =>
  grants.save(userId, ORG, linearUserId, {
    accessToken: 'lin_oauth_first_access',
    refreshToken: 'first-refresh',
    expiresAt: clock + 86_399_000,
  });

describe('LinearGrants', () => {
  it('keeps tokens sealed and finds the workspace by url key', async () => {
    save();
    const raw = JSON.stringify(
      db.db.query('SELECT * FROM linear_grants').all()
    );
    expect(raw).not.toContain('lin_oauth_first_access');
    expect(raw).not.toContain('first-refresh');
    expect(grants.workspace('acme')).toEqual({ orgId: 'org-1', name: 'Acme' });
    expect(grants.workspace('nope')).toBeNull();
    expect(grants.member('usr_ada', 'org-1')).toEqual({
      linearUserId: 'lin-ada',
    });
    expect(grants.member('usr_eve', 'org-1')).toBeNull();
    expect(grants.workspacesOf('usr_ada')).toEqual([
      { urlKey: 'acme', name: 'Acme' },
    ]);
    expect(await grants.accessToken('usr_ada', 'org-1')).toBe(
      'lin_oauth_first_access'
    );
    expect(refreshes).toEqual([]);
  });

  it('refreshes a token within five minutes of expiry and stores the new pair', async () => {
    save();
    clock += 86_399_000 - 4 * 60_000;
    expect(await grants.accessToken('usr_ada', 'org-1')).toBe(
      'lin_oauth_new_access'
    );
    expect(refreshes[0]?.get('grant_type')).toBe('refresh_token');
    expect(refreshes[0]?.get('refresh_token')).toBe('first-refresh');
    expect(refreshes[0]?.get('client_id')).toBe('lin-client');
    expect(await grants.accessToken('usr_ada', 'org-1')).toBe(
      'lin_oauth_new_access'
    );
    expect(refreshes.length).toBe(1);
  });

  it('drops a grant Linear no longer honours', async () => {
    save();
    clock += 86_400_000;
    refreshAnswer = () =>
      Response.json({ error: 'invalid_grant' }, { status: 400 });
    await expect(grants.accessToken('usr_ada', 'org-1')).rejects.toBeInstanceOf(
      GrantGone
    );
    expect(grants.member('usr_ada', 'org-1')).toBeNull();
    expect(grants.workspace('acme')).toBeNull();
  });

  it('keeps one grant per person per workspace, and follows a rename', () => {
    save();
    save('usr_ada');
    save('usr_bob', 'lin-bob');
    grants.save(
      'usr_bob',
      { ...ORG, urlKey: 'acme-co', name: 'Acme Co' },
      'lin-bob',
      {
        accessToken: 'lin_oauth_x',
        refreshToken: null,
        expiresAt: null,
      }
    );
    expect(
      db.db.query('SELECT COUNT(*) AS n FROM linear_grants').get()
    ).toEqual({ n: 2 });
    expect(grants.workspace('acme-co')).toEqual({
      orgId: 'org-1',
      name: 'Acme Co',
    });
    expect(grants.workspace('acme')).toBeNull();
  });
});
