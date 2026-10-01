import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { MAX_TASK_FIELD_BYTES } from '../../../src/team/federation/taskOps.js';
import { daemons } from './helpers/daemon.js';

const { teammate, cleanup, setup } = daemons();
// Several real daemons syncing through a bare remote take seconds each.
const SLOW = 60_000;
beforeEach(setup);
afterEach(cleanup);

describe('/api/team federation routes', () => {
  it(
    'shows keys at the decide tier and never to the shared agent token',
    async () => {
      const ada = await teammate('ada');
      expect((await ada.asAgent('/api/team/keys')).status).toBe(403);
      const keys = await ada.api('/api/team/keys');
      expect(keys.status).toBe(200);
      expect(keys.body?.machine).toMatchObject({
        handle: 'ada',
        fingerprint: expect.stringMatching(/^([0-9A-Z]{4}-){5}[0-9A-Z]{4}$/),
      });
      expect(keys.body?.team).toBeNull();
    },
    SLOW
  );

  it(
    'founds a team at the operator tier, once, and reports it on /api/board-sync at the request tier',
    async () => {
      const ada = await teammate('ada');
      expect(
        (await ada.asAgent('/api/team/found', { method: 'POST', body: '{}' }))
          .status
      ).toBe(403);
      const founded = await ada.api('/api/team/found', {
        method: 'POST',
        body: JSON.stringify({ name: 'acme' }),
      });
      expect(founded.status).toBe(200);
      expect(String(founded.body?.recoveryCode)).toMatch(
        /^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/
      );
      expect(
        (await ada.api('/api/team/found', { method: 'POST', body: '{}' }))
          .status
      ).toBe(409);
      const status = await ada.asAgent('/api/board-sync');
      expect(status.body).toMatchObject({
        founded: true,
        teamId: founded.body?.teamId,
        transport: 'git',
      });
      expect(typeof status.body?.legacyUntil).toBe('string');
    },
    SLOW
  );

  it(
    'admits a waiting machine by fingerprint and refuses a mismatch',
    async () => {
      const ada = await teammate('ada');
      const bob = await teammate('bob');
      await ada.api('/api/team/found', { method: 'POST', body: '{}' });
      await ada.sync();
      await bob.sync();
      await ada.sync();
      const waiting = (await ada.api('/api/team/keys')).body?.waiting as {
        replica: string;
        fingerprint: string;
      }[];
      expect(waiting).toHaveLength(1);
      const [w] = waiting;
      const bad = await ada.api(`/api/team/keys/${w?.replica}/admit`, {
        method: 'POST',
        body: JSON.stringify({ fingerprint: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA' }),
      });
      expect(bad.status).toBe(409);
      const good = await ada.api(`/api/team/keys/${w?.replica}/admit`, {
        method: 'POST',
        body: JSON.stringify({ fingerprint: w?.fingerprint }),
      });
      expect(good.status).toBe(200);
      await ada.sync();
      await bob.sync();
      const mine = (await bob.api('/api/team/keys')).body?.roster as {
        handle: string;
      }[];
      expect(mine.map((r) => r.handle).sort()).toEqual(['ada', 'bob']);
    },
    SLOW
  );

  it(
    'protects the last admin and answers 413 for a task field over the cap',
    async () => {
      const ada = await teammate('ada');
      await ada.api('/api/team/found', { method: 'POST', body: '{}' });
      const me = (await ada.api('/api/team/keys')).body?.machine as {
        replica: string;
      };
      expect(
        (
          await ada.api(`/api/team/keys/${me.replica}/revoke`, {
            method: 'POST',
            body: '{}',
          })
        ).status
      ).toBe(409);
      const huge = await ada.api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: 'huge',
          description: 'z'.repeat(MAX_TASK_FIELD_BYTES + 1),
        }),
      });
      expect(huge.status).toBe(413);
      expect(huge.body?.code).toBe('too_large');
    },
    SLOW
  );

  it(
    'refuses a new handle past the seats with 402 seat_limit',
    async () => {
      const [ada, bob, cy, dee] = await Promise.all(
        ['ada', 'bob', 'cy', 'dee'].map((h) => teammate(h))
      );
      await ada.api('/api/team/found', { method: 'POST', body: '{}' });
      for (const t of [ada, bob, cy, dee, ada]) await t.sync();
      const waiting = (await ada.api('/api/team/keys')).body?.waiting as {
        replica: string;
        handle: string;
        fingerprint: string;
      }[];
      const byHandle = new Map(waiting.map((w) => [w.handle, w]));
      for (const h of ['bob', 'cy']) {
        const w = byHandle.get(h);
        expect(
          (
            await ada.api(`/api/team/keys/${w?.replica}/admit`, {
              method: 'POST',
              body: JSON.stringify({ fingerprint: w?.fingerprint }),
            })
          ).status
        ).toBe(200);
      }
      const dw = byHandle.get('dee');
      const past = await ada.api(`/api/team/keys/${dw?.replica}/admit`, {
        method: 'POST',
        body: JSON.stringify({ fingerprint: dw?.fingerprint }),
      });
      expect(past.status).toBe(402);
      expect(past.body?.code).toBe('seat_limit');
    },
    SLOW
  );

  // FW-R2: the daemon route for dismissing an op no build reads; a known op
  // is never dismissable, and the shared agent token never reaches it.
  it(
    'dismisses only at the operator tier, and refuses an op every build reads',
    async () => {
      const ada = await teammate('ada');
      await ada.found();
      const me = (await ada.keys()).machine.replica;
      const op = { replica: me, seq: 1, hash: '0'.repeat(64) };
      expect(
        (
          await ada.asAgent('/api/team/dismiss', {
            method: 'POST',
            body: JSON.stringify(op),
          })
        ).status
      ).toBe(403);
      const refused = await ada.api('/api/team/dismiss', {
        method: 'POST',
        body: JSON.stringify(op),
      });
      expect(refused.status).toBe(400);
      expect(refused.body?.code).toBe('invalid');
    },
    SLOW
  );

  // FW-R22 M-e: the way out of a held invite.
  it(
    'abandons a held invite at the operator tier, and says so when there is none',
    async () => {
      const ada = await teammate('ada');
      expect(
        (
          await ada.asAgent('/api/team/abandon-invite', {
            method: 'POST',
            body: '{}',
          })
        ).status
      ).toBe(403);
      const none = await ada.api('/api/team/abandon-invite', {
        method: 'POST',
        body: '{}',
      });
      expect(none.status).toBe(409);
      expect(none.body?.code).toBe('conflict');
    },
    SLOW
  );
});
