import type { Message } from '@dispatch/protocol';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  advance,
  cluster,
  editRemote,
  problemsOf,
  quiesce,
} from './harness/cluster.js';
import type { Cluster, Member } from './harness/cluster.js';
import {
  appendSealedMail,
  appendSignedOp,
  duplicateLastLine,
} from './harness/forge.js';
import {
  boardProjection,
  expectConverged,
  expectMessagesConverged,
  rosterProjection,
} from './harness/projections.js';
import { plantedBodiesInHistory, q7Violations } from './harness/q7.js';

// F2 Task 18b: mail between real daemons over one git remote, each scenario
// ending converged with Q7 holding and no planted body in the history.
const SLOW = 180_000;

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
});

type TeamOpts = Parameters<typeof cluster>[1] & { observers?: string[] };

async function team(names: string[], opts: TeamOpts = {}): Promise<Cluster> {
  const c = await cluster(names, opts);
  stop = c.stop;
  const [founder, ...rest] = c.members as [Member, ...Member[]];
  await founder.handle.found();
  await quiesce(c.members);
  for (const m of rest)
    await founder.handle.admit(m.handle, {
      observer: (opts.observers ?? []).includes(m.name),
    });
  await quiesce(c.members);
  return c;
}

// Quiesce, then the checks every scenario ends with.
async function finish(
  c: Cluster,
  members: Member[] = c.members,
  planted: readonly string[] = []
): Promise<void> {
  await quiesce(members);
  await expectConverged(members, [boardProjection, rosterProjection]);
  expectMessagesConverged(members);
  expect(q7Violations(c.remote, members)).toEqual([]);
  expect(plantedBodiesInHistory(c.remote, planted)).toEqual([]);
}

const rows = <T>(m: Member, sql: string, params: (string | number)[] = []) =>
  m.handle.messagesDb<T>(sql, params);

function authored(
  id: string,
  from: string,
  to: string[],
  body: string,
  refs: Message['refs'] = []
): Message {
  return {
    id,
    thread: id,
    replyTo: null,
    from,
    to,
    kind: from === 'agent:dispatch' ? 'notice' : 'message',
    body,
    refs,
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-09-26T10:00:00.000Z',
  };
}

describe('mail convergence over git', () => {
  it(
    'stores each message once per home through a partition and a replayed push',
    async () => {
      const c = await team(['ada', 'bob', 'cy']);
      const [ada, bob, cy] = c.members as [Member, Member, Member];
      bob.handle.partition(true);
      const toBob = await ada.handle.send({
        to: ['human:bob'],
        kind: 'message',
        body: 'while bob was away',
      });
      const toAda = await bob.handle.send({
        to: ['human:ada'],
        kind: 'message',
        body: 'written offline',
      });
      await quiesce([ada, cy]);
      bob.handle.partition(false);
      await quiesce(c.members);
      const adaReplica = await ada.handle.replica();
      editRemote(c.remote, (dir) => {
        duplicateLastLine(dir, adaReplica);
      });
      await finish(c, c.members, ['while bob was away', 'written offline']);
      expect(
        rows<{ n: number }>(
          bob,
          'SELECT COUNT(*) AS n FROM messages WHERE id = ?',
          [toBob.id]
        )[0]?.n
      ).toBe(1);
      expect(
        rows<{ n: number }>(
          ada,
          'SELECT COUNT(*) AS n FROM messages WHERE id = ?',
          [toAda.id]
        )[0]?.n
      ).toBe(1);
    },
    SLOW
  );

  it(
    'lets a human answer on one of two devices; both show it answered and the run gets one answer',
    async () => {
      const c = await team(['bob', 'ada', 'ada2'], {
        gitNames: { ada2: 'ada' },
      });
      const [bob, ada, ada2] = c.members as [Member, Member, Member];
      const run = await bob.handle.startRun(
        await bob.handle.create('needs ada')
      );
      const q = await bob.handle.send(
        {
          to: ['human:ada'],
          kind: 'question',
          blocking: true,
          body: 'which schema?',
        },
        run.token
      );
      await quiesce(c.members);
      for (const m of [ada, ada2])
        expect(await m.handle.openDecisions()).toContain(q.id);
      await ada2.handle.reply(q.id, { body: 'v2' });
      await finish(c);
      for (const m of [ada, ada2])
        expect(await m.handle.openDecisions()).not.toContain(q.id);
      expect((await bob.handle.answerOf(q.id)).answer?.body).toBe('v2');
      expect(
        rows<{ n: number }>(
          bob,
          "SELECT COUNT(*) AS n FROM messages WHERE reply_to = ? AND kind = 'answer'",
          [q.id]
        )[0]?.n
      ).toBe(1);
    },
    SLOW
  );

  it(
    'accepts the first answer the origin applies and supersedes the other everywhere, telling its sender',
    async () => {
      const c = await team(['ada', 'bob', 'cy']);
      const [ada, bob, cy] = c.members as [Member, Member, Member];
      const run = await ada.handle.startRun(
        await ada.handle.create('asks two people')
      );
      const q = await ada.handle.send(
        {
          to: ['human:bob', 'human:cy'],
          kind: 'question',
          blocking: true,
          body: 'A or B?',
        },
        run.token
      );
      await quiesce(c.members);
      const a = await bob.handle.reply(q.id, { body: 'A' });
      const b = await cy.handle.reply(q.id, { body: 'B' });
      await bob.handle.sync();
      await ada.handle.sync();
      await cy.handle.sync();
      await finish(c);
      expect((await ada.handle.answerOf(q.id)).answer?.id).toBe(a.id);
      // At the settler cy's answer is a superseded reply; cy's own copy may
      // stay pending, since bob's answer never reaches it (FW-R33).
      expect(
        rows(ada, 'SELECT settled_as, kind FROM messages WHERE id = ?', [
          b.id,
        ])[0]
      ).toEqual({ settled_as: 'superseded', kind: 'message' });
      expect(
        rows(
          cy,
          "SELECT id FROM messages WHERE from_addr = 'agent:dispatch' AND body LIKE ?",
          [`${b.id} was already answered%`]
        )
      ).toHaveLength(1);
    },
    SLOW
  );

  it(
    'keeps a question from another machine open across the recipient restarting, and the run gets the answer (Review Focus 1)',
    async () => {
      const c = await team(['ada', 'bob']);
      const [ada, bob] = c.members as [Member, Member];
      const run = await ada.handle.startRun(
        await ada.handle.create('asks bob')
      );
      const q = await ada.handle.send(
        {
          to: ['human:bob'],
          kind: 'question',
          blocking: true,
          body: 'still there?',
        },
        run.token
      );
      await quiesce(c.members);
      await bob.handle.restart();
      expect(await bob.handle.openDecisions()).toContain(q.id);
      await bob.handle.reply(q.id, { body: 'yes' });
      await finish(c);
      expect((await ada.handle.answerOf(q.id)).answer?.body).toBe('yes');
    },
    SLOW
  );

  it(
    "moves held task mail to the machine where the task's run starts, once",
    async () => {
      const c = await team(['ada', 'bob', 'cy']);
      const [ada, bob, cy] = c.members as [Member, Member, Member];
      // FW-R33(2): an unassigned task's mail waits at its origin.
      const task = await ada.handle.create('for whoever runs it', {
        assignee: 'human',
      });
      await quiesce(c.members);
      const m = await ada.handle.send({
        to: [`task:${task}`],
        kind: 'message',
        body: 'context for whoever runs this',
      });
      await quiesce(c.members);
      await bob.handle.startRun(task);
      await finish(c, c.members, ['context for whoever runs this']);
      const seen = [
        ...bob.handle.executor.sent,
        ...bob.handle.executor.notified,
      ];
      expect(
        seen.some((s) => s.includes('context for whoever runs this'))
      ).toBe(true);
      expect(
        rows(
          ada,
          "SELECT id FROM deliveries WHERE message_id = ? AND state = 'held'",
          [m.id]
        )
      ).toEqual([]);
      expect(rows(cy, 'SELECT id FROM messages WHERE id = ?', [m.id])).toEqual(
        []
      );
    },
    SLOW
  );

  it(
    'converges channel joins and leaves made concurrently, and keeps a channel that predates the founding',
    async () => {
      const c = await cluster(['ada', 'bob']);
      stop = c.stop;
      const [ada, bob] = c.members as [Member, Member];
      const join = (m: Member, ch: string, member: string) =>
        m.handle.api(`/api/channels/${ch}/members`, {
          method: 'POST',
          body: JSON.stringify({ member }),
        });
      await join(ada, 'design', 'human:ada');
      await ada.handle.found();
      await quiesce(c.members);
      await ada.handle.admit(bob.handle);
      await quiesce(c.members);
      await join(ada, 'ops', 'human:ada');
      await join(bob, 'ops', 'human:bob');
      await quiesce(c.members);
      advance([bob], 1000);
      await bob.handle.api(
        `/api/channels/ops/members/${encodeURIComponent('human:ada')}`,
        {
          method: 'DELETE',
        }
      );
      await finish(c);
      for (const m of c.members) {
        const channels = ((await m.handle.api('/api/channels')).body?.[
          'channels'
        ] ?? []) as { name: string; members: string[] }[];
        expect(channels.find((ch) => ch.name === 'ops')?.members).toEqual([
          'human:bob',
        ]);
        expect(channels.find((ch) => ch.name === 'design')?.members).toEqual([
          'human:ada',
        ]);
      }
    },
    SLOW
  );

  it(
    "stores a locally muted remote agent's later messages as read, and leaves its own machine alone",
    async () => {
      const c = await team(['ada', 'bob']);
      const [ada, bob] = c.members as [Member, Member];
      const { address, token } = await bob.handle.registerAgent('codex');
      await bob.handle.send(
        { to: ['human:ada'], kind: 'message', body: 'first' },
        token
      );
      await quiesce(c.members);
      expect(
        (
          await ada.handle.api(
            `/api/agents/${encodeURIComponent(address)}/mute`,
            { method: 'POST' }
          )
        ).status
      ).toBe(200);
      const later = await bob.handle.send(
        { to: ['human:ada', 'human:bob'], kind: 'message', body: 'second' },
        token
      );
      await finish(c);
      expect(
        rows<{ state: string }>(
          ada,
          'SELECT state FROM deliveries WHERE message_id = ?',
          [later.id]
        ).map((d) => d.state)
      ).toEqual(['read']);
      expect(
        rows<{ state: string }>(
          bob,
          'SELECT state FROM deliveries WHERE message_id = ?',
          [later.id]
        ).map((d) => d.state)
      ).toEqual(['notified']);
    },
    SLOW
  );

  it(
    "refuses a presence claim on another replica's run, and that run's mail still counts only from its owner",
    async () => {
      const c = await team(['ada', 'bob', 'cy']);
      const [ada, bob, cy] = c.members as [Member, Member, Member];
      const task = await bob.handle.create('bob runs it');
      await quiesce(c.members);
      const run = await bob.handle.startRun(task);
      await quiesce(c.members);
      await cy.handle.stop();
      editRemote(c.remote, (dir) => {
        appendSignedOp(dir, cy, {
          type: 'presence',
          body: {
            kind: 'run',
            run: run.runId,
            task,
            runKind: 'execute',
            live: true,
          },
        });
      });
      await quiesce([ada, bob]);
      const problem =
        (await problemsOf(ada)).find((p) => p.message.includes(run.runId))
          ?.message ?? '';
      expect(problem).toContain('cy');
      expect(problem).toContain('already running on bob');
      const m = await bob.handle.send(
        { to: ['human:ada'], kind: 'message', body: 'from the real run' },
        run.token
      );
      await finish(c, [ada, bob]);
      expect(
        rows<{ origin: string }>(
          ada,
          'SELECT origin FROM messages WHERE id = ?',
          [m.id]
        )[0]?.origin
      ).toBe(await bob.handle.replica());
    },
    SLOW
  );

  it(
    "stores a teammate system's notice about an exchanged message, and refuses one about anything else",
    async () => {
      const c = await team(['ada', 'bob']);
      const [ada, bob] = c.members as [Member, Member];
      const dm = await ada.handle.send({
        to: ['human:bob'],
        kind: 'message',
        body: 'hi bob',
      });
      await quiesce(c.members);
      const bobReplica = await bob.handle.replica();
      await bob.handle.stop();
      editRemote(c.remote, (dir) => {
        appendSealedMail(
          dir,
          bob,
          authored(
            'm-0000about',
            'agent:dispatch',
            ['human:ada'],
            'about your message',
            [{ type: 'message', id: dm.id }]
          ),
          [ada]
        );
        appendSealedMail(
          dir,
          bob,
          authored(
            'm-00unrelated',
            'agent:dispatch',
            ['human:ada'],
            'about nothing we share',
            [{ type: 'message', id: 'm-00not-shared' }]
          ),
          [ada]
        );
      });
      await finish(c, [ada]);
      expect(
        rows(ada, 'SELECT origin, from_addr FROM messages WHERE id = ?', [
          'm-0000about',
        ])[0]
      ).toEqual({ origin: bobReplica, from_addr: 'agent:dispatch' });
      expect(
        rows(ada, 'SELECT id FROM messages WHERE id = ?', ['m-00unrelated'])
      ).toEqual([]);
      expect(
        (await problemsOf(ada)).some(
          (p) =>
            p.subject === `mail-drop:${bobReplica}` &&
            p.message.includes('m-00unrelated')
        )
      ).toBe(true);
    },
    SLOW
  );

  it(
    'keeps mail from a run whose presence has not arrived parked past seven days, and applies it when it does',
    async () => {
      const c = await team(['ada', 'bob']);
      const [ada, bob] = c.members as [Member, Member];
      await bob.handle.stop();
      const run = 'r-0000000000ee';
      editRemote(c.remote, (dir) => {
        appendSealedMail(
          dir,
          bob,
          authored('m-0000parked', `run:${run}`, ['human:ada'], 'parked'),
          [ada]
        );
      });
      await quiesce([ada]);
      expect(
        rows(ada, 'SELECT id FROM messages WHERE id = ?', ['m-0000parked'])
      ).toEqual([]);
      advance([ada], 8 * 24 * 60 * 60 * 1000);
      await quiesce([ada]);
      editRemote(c.remote, (dir) => {
        appendSignedOp(dir, bob, {
          type: 'presence',
          body: { kind: 'run', run, task: null, runKind: 'review', live: true },
          hlcMs: ada.clock.ms,
        });
      });
      await finish(c, [ada]);
      expect(
        rows<{ body: string }>(ada, 'SELECT body FROM messages WHERE id = ?', [
          'm-0000parked',
        ])[0]?.body
      ).toBe('parked');
    },
    SLOW
  );

  it(
    'lets an admitted observer read mail that leaves a machine, and nothing that stays',
    async () => {
      const c = await team(['ada', 'bob', 'ops'], { observers: ['ops'] });
      const [ada, , ops] = c.members as [Member, Member, Member];
      const out = await ada.handle.send({
        to: ['human:bob'],
        kind: 'message',
        body: 'leaves the machine',
      });
      const home = await ada.handle.send({
        to: ['human:ada'],
        kind: 'message',
        body: 'stays home',
      });
      await finish(c, c.members, ['leaves the machine', 'stays home']);
      const seen = rows<{ id: string }>(ops, 'SELECT id FROM messages').map(
        (r) => r.id
      );
      expect(seen).toContain(out.id);
      expect(seen).not.toContain(home.id);
    },
    SLOW
  );

  it(
    'never lets gate, overseer or A2A content leave the machine, in the branch or its history (Review Focus 5)',
    async () => {
      const c = await team(['ada', 'bob']);
      const [ada] = c.members as [Member, Member];
      const planted = [
        'GATE-BODY-7f3',
        'OVERSEER-BODY-9c1',
        'A2A-BODY-2d8',
        'SEALED-DM-1a2',
      ];
      const gate = await ada.handle.trySend({
        to: ['human:bob'],
        kind: 'question',
        blocking: true,
        choices: ['approve', 'deny'],
        body: planted[0],
        data: { type: 'deploy-approval' },
      });
      const overseer = await ada.handle.trySend({
        to: ['human:bob', 'agent:ada/overseer'],
        kind: 'message',
        body: planted[1],
      });
      const a2a = await ada.handle.trySend({
        to: ['human:bob', 'agent:ada/a2a.acme'],
        kind: 'message',
        body: planted[2],
      });
      for (const r of [gate, overseer, a2a])
        expect(r.status).toBeGreaterThanOrEqual(400);
      // A DM that does cross machines is sealed, so its body is not in history either.
      await ada.handle.send({
        to: ['human:bob'],
        kind: 'message',
        body: planted[3],
      });
      await finish(c, c.members, planted);
    },
    SLOW
  );
});
