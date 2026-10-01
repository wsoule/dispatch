import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { ApiContext } from '../../../src/api.js';
import {
  boardSyncNow,
  handleFederationRoute,
  statusFor,
} from '../../../src/team/federation/routes.js';
import { MAX_TASK_FIELD_BYTES } from '../../../src/team/federation/taskOps.js';
import { daemons } from './helpers/daemon.js';
import { testReplica } from './helpers/replica.js';

const { teammate, cleanup, setup } = daemons();
// Several real daemons syncing through a bare remote take seconds each.
const SLOW = 60_000;
beforeEach(setup);
afterEach(cleanup);

describe('statusFor', () => {
  const status = {
    enabled: true,
    remote: 'https://ada:ghp_secret@example.com/team/board.git?token=x',
    transportHealth: { kind: 'git' },
    federationProblems: [],
    founded: true,
  };
  it('keeps everything at the decide tier', () => {
    expect(statusFor(status, 'decide')).toEqual(status);
  });
  it('drops health, problems and the remote credentials below it', () => {
    expect(statusFor(status, 'request')).toEqual({
      enabled: true,
      remote: 'https://example.com/team/board.git',
      founded: true,
    });
    expect(
      statusFor(
        { ...status, remote: 'git@example.com:team/board.git' },
        'request'
      ).remote
    ).toBe('git@example.com:team/board.git');
  });
});

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
      // Inputs are capped before anything is signed.
      expect(
        (
          await ada.api('/api/team/found', {
            method: 'POST',
            body: JSON.stringify({ name: 'n'.repeat(2000) }),
          })
        ).status
      ).toBe(400);
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
      // R1: the request tier sees the team's four fields, not its health.
      expect(status.body).not.toHaveProperty('transportHealth');
      expect(status.body).not.toHaveProperty('federationProblems');
      const full = await ada.api('/api/board-sync');
      expect(full.body).toHaveProperty('transportHealth');
      expect(full.body).toHaveProperty('federationProblems');
      // I1: POST /now answers with the same view for the same tier.
      const now = await ada.asAgent('/api/board-sync/now', { method: 'POST' });
      expect(now.status).toBe(200);
      expect(now.body).not.toHaveProperty('transportHealth');
      expect(now.body).not.toHaveProperty('federationProblems');
      expect(now.body).toMatchObject({ founded: true });
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
      // A retry of a change the roster already shows answers `already`.
      const post = (action: string, body: unknown) =>
        ada.api(`/api/team/keys/${w?.replica}/${action}`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
      const again = await post('admit', { fingerprint: w?.fingerprint });
      expect([again.status, again.body?.already]).toEqual([200, true]);
      const role = await post('role', { role: 'member' });
      expect([role.status, role.body?.already]).toEqual([200, true]);
      await ada.sync();
      await bob.sync();
      const mine = (await bob.api('/api/team/keys')).body?.roster as {
        handle: string;
      }[];
      expect(mine.map((r) => r.handle).sort()).toEqual(['ada', 'bob']);
      expect((await post('revoke', {})).status).toBe(200);
      const revoked = await post('revoke', {});
      expect([revoked.status, revoked.body?.already]).toEqual([200, true]);
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

// A route never hangs on an unreachable remote: it waits for its pass at
// most passWaitMs, then answers with its local result and pending: true.
describe('a route whose pass does not finish', () => {
  it('answers within the bound, and names a failure that comes later', async () => {
    const ada = testReplica('ada');
    try {
      ada.roster.found('acme');
      let finish = (): void => {};
      let lastError: string | null = null;
      const service = {
        syncNow: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        status: () => ({ lastError }),
      };
      const ctx = {
        rootDir: ada.dir,
        boardSync: service,
        federation: {
          roster: ada.roster,
          fed: ada.fed,
          handle: 'ada',
          device: 'laptop',
          now: () => ada.clock.now,
          remote: null,
          label: (r: string) => r,
          observer: () => null,
          passWaitMs: 50,
        },
      } as unknown as ApiContext;
      const started = Date.now();
      const res = await handleFederationRoute(
        new Request('http://x/api/team/invite', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ handle: 'bob' }),
        }),
        ctx,
        ['team', 'invite'],
        'POST'
      );
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { code?: string; pending?: boolean };
      expect(body.pending).toBe(true);
      expect(typeof body.code).toBe('string');
      lastError = 'the remote is unreachable';
      finish();
      await new Promise((r) => setTimeout(r, 10));
      expect(
        ada.fed
          .problems()
          .some((p) => p.message.includes('the remote is unreachable'))
      ).toBe(true);
      // I1: POST /api/board-sync/now is bounded the same way.
      const now = await boardSyncNow(ctx, ctx.boardSync as never);
      expect(now.pending).toBe(true);
      finish();
    } finally {
      ada.close();
    }
  });
});

describe('a route against an offline remote', () => {
  it(
    'revokes from the last applied cut with a warning instead of hanging',
    async () => {
      const ada = await teammate('ada');
      const bob = await teammate('bob');
      await ada.found();
      await ada.admit(bob);
      await ada.sync();
      const replica = await bob.replica();
      ada.partition(true);
      const res = await ada.api(`/api/team/keys/${replica}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'lost laptop' }),
      });
      expect(res.status).toBe(200);
      expect(String(res.body?.warning)).toContain('could not pull first');
    },
    SLOW
  );
});
