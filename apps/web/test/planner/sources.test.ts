import { describe, expect, it } from 'bun:test';

import { TeamDb } from '../../src/db.js';
import { Sealer } from '../../src/linear.js';
import { GrantGone, LinearGrants } from '../../src/planner/grants.js';
import { linearWorkspace } from '../../src/planner/sources.js';

// A granted workspace whose token Linear stopped honouring before it expired.

describe('linearWorkspace', () => {
  it('forgets a grant Linear answers 401 for, so the member is asked to reopen it', async () => {
    const db = new TeamDb(':memory:');
    const unauthorized = (() =>
      Promise.resolve(
        Response.json(
          { errors: [{ message: 'Authentication required' }] },
          { status: 401 }
        )
      )) as unknown as typeof fetch;
    const grants = new LinearGrants(
      db.db,
      new Sealer('secret'),
      'lin-client',
      unauthorized
    );
    grants.save(
      'usr_ada',
      { id: 'org-1', name: 'Acme', urlKey: 'acme' },
      'lin-ada',
      {
        accessToken: 'lin_oauth_revoked',
        refreshToken: null,
        expiresAt: null,
      }
    );
    const source = linearWorkspace(
      grants,
      { orgId: 'org-1', name: 'Acme' },
      unauthorized
    );
    await expect(source.load('usr_ada')).rejects.toBeInstanceOf(GrantGone);
    expect(grants.member('usr_ada', 'org-1')).toBeNull();
    db.close();
  });
});
