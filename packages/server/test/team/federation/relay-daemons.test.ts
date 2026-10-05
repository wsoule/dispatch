import type { LogEntry } from '@dispatch/protocol/federation';
import { afterEach, describe, expect, it } from 'bun:test';

import { runGitSync } from '../../orchestrator/helpers.js';
import { startFakeRelay } from './fakeRelay.js';
import type { FakeRelay } from './fakeRelay.js';
import { cluster, quiesce } from './harness/cluster.js';
import type { Member } from './harness/cluster.js';

// Task 22 between real daemons: a team switches from git to the fake relay,
// exchanges mail and board ops there, and switches back.
const SLOW = 240_000;
let stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.reverse()) await stop();
  stops = [];
});

// A daemon's own log, read from its state.db as the relay registers it.
const ownLog = (m: Member): LogEntry[] =>
  m.handle
    .stateDb<{ op_json: string }>('SELECT op_json FROM fed_log ORDER BY seq')
    .map((r) => JSON.parse(r.op_json) as LogEntry);
const transportOf = async (m: Member): Promise<unknown> =>
  ((await m.handle.api('/api/board-sync')).body as { transport?: unknown })
    .transport;
const commits = (remote: string): number =>
  Number(runGitSync(remote, ['rev-list', '--count', 'dispatch-sync']).trim());

describe('a team of real daemons on the relay', () => {
  it(
    'switches from git, exchanges mail and board ops on the relay, and switches back',
    async () => {
      const c = await cluster(['ada', 'bob', 'cy']);
      stops.push(c.stop);
      const [ada, bob, cy] = c.members as [Member, Member, Member];
      await ada.handle.found();
      await quiesce(c.members);
      for (const m of [bob, cy]) await ada.handle.admit(m.handle);
      await quiesce(c.members);
      expect(
        (
          await ada.handle.api('/api/team/close-legacy', {
            method: 'POST',
            body: '{}',
          })
        ).status
      ).toBe(200);
      await quiesce(c.members);
      const relay: FakeRelay = await startFakeRelay({
        fed: { ownLog: () => ownLog(ada) },
        clock: {
          get now() {
            return new Date(ada.clock.ms);
          },
        },
      });
      stops.push(() => relay.stop());
      const switched = await ada.handle.api('/api/team/transport', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'relay',
          url: relay.url,
          confirmed: true,
        }),
      });
      expect(switched.status).toBe(200);
      await quiesce(c.members);
      for (const m of c.members) {
        expect(await transportOf(m)).toBe('relay');
        const head = ownLog(m).at(-1)?.seq;
        expect(relay.stored(await m.handle.replica()).at(-1)?.seq).toBe(head);
      }
      // The git branch is not written once the team is on the relay.
      const onGit = commits(c.remote);
      const sent = await ada.handle.send({
        to: ['human:bob'],
        kind: 'message',
        body: 'over the relay',
      });
      const task = await bob.handle.create('made on the relay');
      await quiesce(c.members);
      expect(
        bob.handle.messagesDb<{ body: string }>(
          'SELECT body FROM messages WHERE id = ?',
          [sent.id]
        )
      ).toEqual([{ body: 'over the relay' }]);
      for (const m of [ada, cy])
        expect(await m.handle.title(task)).toBe('made on the relay');
      expect(commits(c.remote)).toBe(onGit);
      // And back to git, by the same op.
      expect(
        (
          await ada.handle.api('/api/team/transport', {
            method: 'POST',
            body: JSON.stringify({ kind: 'git' }),
          })
        ).status
      ).toBe(200);
      await quiesce(c.members);
      for (const m of c.members) expect(await transportOf(m)).toBe('git');
      const back = await cy.handle.create('made on git again');
      await quiesce(c.members);
      for (const m of [ada, bob])
        expect(await m.handle.title(back)).toBe('made on git again');
      expect(commits(c.remote)).toBeGreaterThan(onGit);
    },
    SLOW
  );
});
