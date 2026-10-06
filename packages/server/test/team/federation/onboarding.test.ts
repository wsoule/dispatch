import { afterEach, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';

import {
  decodeTeamLink,
  encodeTeamLink,
} from '../../../src/team/federation/onboarding.js';
import type { TeamStatus } from '../../../src/team/federation/onboarding.js';
import { startFakeRelay } from './fakeRelay.js';
import { advance, cluster, quiesce } from './harness/cluster.js';
import type { Member } from './harness/cluster.js';

// Team setup between real daemons in the fewest actions a person takes:
// the founder starts the team and invites, the joiner pastes the link, and
// nothing else. Syncs between them are the daemons' own passes.
const SLOW = 240_000;
let stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.reverse()) await stop();
  stops = [];
});

const post = (m: Member, path: string, body: Record<string, unknown>) =>
  m.handle.api(path, { method: 'POST', body: JSON.stringify(body) });
// What a client does with a team action: when the daemon answers that it
// is restarting to turn board sync on, it waits for sync and asks again.
// Still one action for the person.
const act = async (
  m: Member,
  path: string,
  body: Record<string, unknown>
): Promise<{
  status: number;
  body: Record<string, unknown> | null;
  restarted: boolean;
}> => {
  const first = await post(m, path, body);
  if (first.status !== 202 || first.body?.code !== 'restarting')
    return { ...first, restarted: false };
  for (let i = 0; i < 300; i++) {
    await Bun.sleep(50);
    const sync = await m.handle
      .api('/api/board-sync')
      .catch(() => ({ status: 0, body: null }));
    if (sync.status === 200 && sync.body?.enabled === true) break;
  }
  return { ...(await post(m, path, body)), restarted: true };
};
const statusOf = async (m: Member): Promise<TeamStatus> =>
  (await m.handle.api('/api/team/status')).body as unknown as TeamStatus;

describe('team setup in two actions', () => {
  it(
    'start, invite, join: both machines see each other, a task syncs and mail flows',
    async () => {
      // Both start as a fresh clone does: board sync off.
      const c = await cluster(['ada', 'bob'], { syncOff: ['ada', 'bob'] });
      stops.push(c.stop);
      const [ada, bob] = c.members as [Member, Member];
      for (const m of c.members) expect((await statusOf(m)).state).toBe('off');
      // The hosted relay's stand-in: keyless registration with a stamp.
      const relay = await startFakeRelay({
        clock: {
          get now() {
            return new Date(ada.clock.ms);
          },
        },
      });
      stops.push(() => relay.stop());
      const actions: string[] = [];
      const began = performance.now();

      // Founder, action 1: start the team (Settings: "Start a team").
      const started = await act(ada, '/api/team/start', {
        name: 'acme',
        relayUrl: relay.url,
        confirmed: true,
      });
      actions.push('ada: start');
      expect(started.restarted).toBe(true);
      expect(started.status).toBe(200);
      expect(started.body?.transport).toEqual({
        kind: 'relay',
        url: relay.url,
      });
      expect(started.body?.notice).toBeNull();
      expect(relay.teamId).toBe(started.body?.teamId as string);

      // Founder, action 2: invite bob, which answers one link.
      const invited = await post(ada, '/api/team/invite', { handle: 'bob' });
      actions.push('ada: invite bob');
      expect(invited.status).toBe(200);
      const link = invited.body?.link as string;
      expect(link.startsWith('dispatch-team:')).toBe(true);
      const decoded = decodeTeamLink(link);
      expect(decoded.team).toBe(started.body?.teamId as string);
      expect(decoded.via).toEqual({ kind: 'relay', url: relay.url });
      expect(decoded.handle).toBe('bob');

      // Joiner, action 1: paste the link.
      const joined = await act(bob, '/api/team/join', { code: link });
      actions.push('bob: join');
      expect([joined.restarted, joined.status, joined.body?.error]).toEqual([
        true,
        200,
        undefined,
      ]);
      expect(joined.status).toBe(200);
      expect(joined.body?.team).toEqual({
        id: started.body?.teamId,
        name: 'acme',
      });

      // The daemons' own syncs, nothing a person does.
      await quiesce(c.members);
      const ms = Math.round(performance.now() - began);
      console.log(
        `team onboarding: ${actions.length} actions (${actions.join(', ')}), ${ms} ms`
      );
      expect(actions).toEqual(['ada: start', 'ada: invite bob', 'bob: join']);

      const [sa, sb] = [await statusOf(ada), await statusOf(bob)];
      for (const s of [sa, sb]) {
        expect(s.state).toBe('member');
        expect(s.team?.name).toBe('acme');
        expect(s.seats?.used).toBe(2);
        expect(s.sync?.kind).toBe('relay');
        expect(s.line).toContain("Team 'acme' · 2 of 3 seats · syncing via");
        expect(s.teammates.map((t) => t.handle).sort()).toEqual(['ada', 'bob']);
      }
      expect(sa.role).toBe('admin');
      expect(sb.role).toBe('member');
      // The optional check reads the same on both machines.
      const checkOnAda = sa.teammates.find((t) => t.handle === 'bob')?.check;
      expect(checkOnAda).toBe(joined.body?.check as string);
      expect(sb.teammates.find((t) => t.handle === 'ada')?.check).toBe(
        checkOnAda
      );

      // A task syncs, and mail flows, over the relay.
      const task = await bob.handle.create('made by the new teammate');
      const sent = await ada.handle.send({
        to: ['human:bob'],
        kind: 'message',
        body: 'welcome aboard',
      });
      await quiesce(c.members);
      expect(await ada.handle.title(task)).toBe('made by the new teammate');
      expect(
        bob.handle.messagesDb<{ body: string }>(
          'SELECT body FROM messages WHERE id = ?',
          [sent.id]
        )
      ).toEqual([{ body: 'welcome aboard' }]);
    },
    SLOW
  );

  it(
    'refuses an expired link, a damaged one, and a link for another team, and lets a reused or forged one in nowhere',
    async () => {
      const c = await cluster(['ada', 'bob']);
      stops.push(c.stop);
      const [ada, bob] = c.members as [Member, Member];
      const started = await post(ada, '/api/team/start', {
        name: 'acme',
        git: true,
      });
      expect(started.status).toBe(200);
      expect(started.body?.transport).toEqual({ kind: 'git' });

      // Expired: a link a week and a day old is refused at join.
      const stale = (await post(ada, '/api/team/invite', { handle: 'bob' }))
        .body?.link as string;
      advance(c.members, 8 * 24 * 60 * 60 * 1000);
      const late = await post(bob, '/api/team/join', { code: stale });
      expect(late.status).toBe(400);
      expect(late.body?.error).toContain('expired');

      // Damaged: one character off fails the checksum.
      const link = (await post(ada, '/api/team/invite', { handle: 'bob' })).body
        ?.link as string;
      const flipped = `${link.slice(0, -3)}${link.at(-3) === 'A' ? 'B' : 'A'}${link.slice(-2)}`;
      const damaged = await post(bob, '/api/team/join', { code: flipped });
      expect(damaged.status).toBe(400);
      expect(damaged.body?.error).toContain('damaged');

      // The real link admits bob.
      expect((await post(bob, '/api/team/join', { code: link })).status).toBe(
        200
      );
      await quiesce(c.members);
      expect((await statusOf(bob)).state).toBe('member');

      // Reused: bob's second machine pastes the same link. It is never let in,
      // and ada's status says why.
      const bob2 = await c.add('bob2', { gitName: 'bob' });
      expect((await post(bob2, '/api/team/join', { code: link })).status).toBe(
        200
      );
      await quiesce(c.members);
      expect((await statusOf(bob2)).state).toBe('joining');
      const reused = (await statusOf(ada)).problems.find((p) =>
        p.message.includes('already used')
      );
      expect(reused?.fix).toMatch(/^dispatch team advanced ack invite:/);

      // Forged: a valid-looking link with a secret nobody issued joins
      // locally and is let in nowhere.
      const cy = await c.add('cy');
      const real = decodeTeamLink(
        (await post(ada, '/api/team/invite', { handle: 'cy' })).body
          ?.link as string
      );
      const forged = encodeTeamLink({ ...real, seed: randomBytes(32) });
      expect((await post(cy, '/api/team/join', { code: forged })).status).toBe(
        200
      );
      await quiesce(c.members);
      expect((await statusOf(cy)).state).toBe('joining');
      expect(
        (await statusOf(ada)).teammates.map((t) => t.handle).sort()
      ).toEqual(['ada', 'bob']);

      // Another team: a member refuses a link naming a team it is not in.
      const elsewhere = encodeTeamLink({
        ...real,
        team: 'f'.repeat(32),
        handle: 'bob',
      });
      const other = await post(bob, '/api/team/join', { code: elsewhere });
      expect(other.status).toBe(400);
      expect(other.body?.error).toContain('another team');
    },
    SLOW
  );

  it(
    'refuses to turn sync on while a run is live, and changes nothing',
    async () => {
      const c = await cluster(['ada'], { syncOff: ['ada'] });
      stops.push(c.stop);
      const [ada] = c.members as [Member];
      const task = await ada.handle.create('long job');
      await ada.handle.startRun(task);
      const refused = await post(ada, '/api/team/start', { git: true });
      expect(refused.status).toBe(409);
      expect(refused.body?.code).toBe('busy');
      expect(String(refused.body?.error)).toContain('1 live run');
      expect((await statusOf(ada)).state).toBe('off');
      // A bad link is refused before anything restarts.
      const bad = await post(ada, '/api/team/join', {
        code: 'dispatch-team:xx',
      });
      expect(bad.status).toBe(400);
      expect(ada.handle.executor.started).toHaveLength(1);
    },
    SLOW
  );

  it(
    'shares one restart between two starts, and starts nothing new meanwhile',
    async () => {
      const c = await cluster(['ada'], { syncOff: ['ada'] });
      stops.push(c.stop);
      const [ada] = c.members as [Member];
      const [a, b] = await Promise.all([
        post(ada, '/api/team/start', { git: true }),
        post(ada, '/api/team/start', { git: true }),
      ]);
      expect([a.status, b.status]).toEqual([202, 202]);
      const meanwhile = await post(ada, '/api/tasks', { title: 'too soon' });
      expect(meanwhile.status).toBe(503);
      expect(String(meanwhile.body?.error)).toContain('restarting');
      // Back with sync on, the start goes through once.
      const started = await act(ada, '/api/team/start', { git: true });
      expect(started.status).toBe(200);
      expect((await statusOf(ada)).state).toBe('member');
      expect(
        (await post(ada, '/api/tasks', { title: 'now fine' })).status
      ).toBe(201);
    },
    SLOW
  );
});
