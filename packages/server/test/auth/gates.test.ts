import { describe, expect, it } from 'bun:test';

import { call, invite, useWorld } from './world.js';

// M5: memory gates, like doc gates, come only from the system, so nobody can
// put a gate in front of the owner that names a proposal the system never
// raised.

const world = useWorld();

describe('raising a system gate by hand', () => {
  it('is refused to a deciding teammate and to the owner', async () => {
    const w = world();
    const dec = await invite(w, 'dec@x.io', 'decide');
    for (const token of [dec.token, w.app]) {
      for (const data of [
        {
          type: 'memory',
          proposalId: 'mp-01K6ABCDEFGHJKMNPQRSTVWXYZ',
          action: 'add',
          scope: 'team',
          kind: 'hazard',
        },
        { type: 'doc', doc: 'doc-x', proposal: 'rev-x' },
      ]) {
        const r = await call(w, token, 'POST', '/api/messages', {
          to: ['human:test'],
          kind: 'question',
          blocking: true,
          choices: ['approve', 'reject'],
          body: 'run:r-000000 proposes a team memory (hazard). Review it in Needs you.',
          data,
        });
        expect(r.status).toBe(403);
      }
    }
  });
});
