import {
  buildOp,
  generateReplicaKeys,
  opHash,
  ZERO_HASH,
} from '@dispatch/protocol/federation';
import type { FederatedOp } from '@dispatch/protocol/federation';
import { afterEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  advance,
  auditKindsOf,
  cluster,
  editRemote,
  problemsOf,
  quiesce,
} from './harness/cluster.js';
import type { Cluster, Member } from './harness/cluster.js';
import {
  appendSignedOp,
  forgeLastTaskLine,
  stubLastTaskLine,
} from './harness/forge.js';
import { legacyClient, olderBuildEdit } from './harness/legacyClient.js';
import type { LegacyClient } from './harness/legacyClient.js';
import {
  boardProjection,
  expectConverged,
  rosterProjection,
} from './harness/projections.js';

// Real daemons and git: each scenario takes seconds.
const SLOW = 180_000;

let stop: (() => Promise<void>) | null = null;
const legacies: LegacyClient[] = [];
afterEach(async () => {
  for (const l of legacies.splice(0)) l.close();
  await stop?.();
  stop = null;
});

// Founds on the first member, then admits the rest by fingerprint.
async function team(
  names: string[],
  opts?: Parameters<typeof cluster>[1],
  before?: (c: Cluster) => Promise<void>
): Promise<Cluster> {
  const c = await cluster(names, opts);
  stop = c.stop;
  await before?.(c);
  const [founder, ...rest] = c.members as [Member, ...Member[]];
  await founder.handle.api('/api/team/found', { method: 'POST', body: '{}' });
  await quiesce(c.members);
  for (const m of rest) await founder.handle.admit(m.handle);
  await quiesce(c.members);
  return c;
}
// A v1 replica on the cluster's clock (its first member's).
async function legacy(c: Cluster, handle: string): Promise<LegacyClient> {
  const [first] = c.members as [Member];
  const l = await legacyClient(c.remote, handle, () => first.clock.ms);
  legacies.push(l);
  return l;
}
const halted = async (m: Member, replica: string) =>
  (await problemsOf(m)).find((p) => p.subject === `replica:${replica}`)
    ?.message ?? '';

describe('board convergence over signed ops', () => {
  it(
    'founds, admits by fingerprint and converges edits from every machine',
    async () => {
      const { members } = await team(['ada', 'bob', 'cy']);
      for (const m of members) await m.handle.create(`from ${m.name}`);
      await quiesce(members);
      await expectConverged(members, [boardProjection, rosterProjection]);
    },
    SLOW
  );

  it(
    'refuses an op whose line was edited on the branch, and keeps everyone else converging',
    async () => {
      const { members, remote } = await team(['ada', 'bob', 'cy']);
      const [ada, bob, cy] = members as [Member, Member, Member];
      const id = await bob.handle.create('honest');
      await bob.handle.sync();
      const replica = await bob.handle.replica();
      await bob.handle.stop();
      editRemote(remote, (dir) =>
        forgeLastTaskLine(dir, replica, id, 'forged')
      );
      await cy.handle.create('after the forgery');
      await quiesce([ada, cy]);
      for (const m of [ada, cy]) {
        expect(await halted(m, replica)).toContain(
          `${replica}'s log fails verification`
        );
        expect(await m.handle.title(id)).toBeNull();
      }
      await expectConverged([ada, cy], [boardProjection]);
    },
    SLOW
  );

  it(
    'halts on a stub standing in for a task op, and keeps the task as it was',
    async () => {
      const { members, remote } = await team(['ada', 'bob', 'cy']);
      const [ada, bob, cy] = members as [Member, Member, Member];
      const id = await bob.handle.create('before');
      await quiesce(members);
      await bob.handle.patch(id, { title: 'after' });
      await bob.handle.sync();
      const replica = await bob.handle.replica();
      await bob.handle.stop();
      editRemote(remote, (dir) => stubLastTaskLine(dir, replica));
      await quiesce([ada, cy]);
      for (const m of [ada, cy]) {
        expect(await halted(m, replica)).toContain(
          'a task op cannot be a stub'
        );
        expect(await m.handle.title(id)).toBe('before');
      }
    },
    SLOW
  );

  it(
    'halts on two histories for one replica (a restored backup), applying nothing of the second',
    async () => {
      const { members, remote } = await team(['ada', 'bob', 'cy']);
      const [ada, bob, cy] = members as [Member, Member, Member];
      const id = await bob.handle.create('first history');
      await quiesce(members);
      const replica = await bob.handle.replica();
      await bob.handle.stop();
      let forkSeq = 0;
      editRemote(remote, (dir) => {
        forkSeq = appendSignedOp(dir, bob, {
          type: 'task',
          body: { task: id, kind: 'put', fields: { title: 'second history' } },
          seq: -1,
        }).seq;
      });
      await quiesce([ada, cy]);
      for (const m of [ada, cy]) {
        expect(await halted(m, replica)).toContain(
          `at seq ${forkSeq}: two ops share this seq`
        );
        expect(await m.handle.title(id)).toBe('first history');
        expect(auditKindsOf(m)).toContain('fork');
      }
    },
    SLOW
  );

  it(
    'loses nothing to a force-push that drops a commit: the clones that hold it push it again',
    async () => {
      const { members, remote } = await team(['ada', 'bob', 'cy']);
      const [, bob] = members as [Member, Member, Member];
      const id = await bob.handle.create('pushed once');
      await quiesce(members);
      editRemote(remote, () => {}, { resetTo: 'HEAD~1', force: true });
      await quiesce(members);
      for (const m of members) {
        expect(await m.handle.title(id)).toBe('pushed once');
        expect(
          (await problemsOf(m)).filter((p) => p.subject.startsWith('replica:'))
        ).toEqual([]);
      }
      await expectConverged(members, [boardProjection, rosterProjection]);
    },
    SLOW
  );

  it(
    'never applies edits from a daemon not yet admitted, and lists it as waiting',
    async () => {
      const c = await team(['ada', 'bob', 'cy']);
      const dee = await c.add('dee');
      const id = await dee.handle.create('not admitted');
      await quiesce(c.members);
      for (const m of c.members.slice(0, 3))
        expect(await m.handle.title(id)).toBeNull();
      const [ada] = c.members as [Member];
      const waiting = (await ada.handle.keys()).waiting.map((w) => w.handle);
      expect(waiting).toEqual(['dee']);
    },
    SLOW
  );

  it(
    "drops a revoked replica's later edits everywhere and lists it revoked",
    async () => {
      const { members } = await team(['ada', 'bob', 'cy']);
      const [ada, bob, cy] = members as [Member, Member, Member];
      const cyReplica = await cy.handle.replica();
      const revoked = await ada.handle.api(
        `/api/team/keys/${cyReplica}/revoke`,
        {
          method: 'POST',
          body: JSON.stringify({ reason: 'left' }),
        }
      );
      expect(revoked.status).toBe(200);
      await quiesce(members);
      const id = await cy.handle.create('after revocation');
      await quiesce(members);
      for (const m of [ada, bob]) {
        expect(await m.handle.title(id)).toBeNull();
        expect(
          (await m.handle.keys()).roster.map((r) => r.replica)
        ).not.toContain(cyReplica);
      }
      await expectConverged([ada, bob], [rosterProjection]);
    },
    SLOW
  );

  // FW-R8/R9: an op no build can read pauses every build; the pause names who
  // can lift it, and an admin's dismiss through the route lifts it everywhere.
  it(
    'pauses on a roster op no build reads, and an admin dismiss lifts it',
    async () => {
      const { members, remote } = await team(['ada', 'bob', 'cy']);
      const [ada, bob, cy] = members as [Member, Member, Member];
      const bobReplica = await bob.handle.replica();
      await bob.handle.stop();
      // After bob's admission, so he stands where his op sits.
      advance(members, 60_000);
      let zap: FederatedOp | null = null;
      editRemote(remote, (dir) => {
        zap = appendSignedOp(dir, bob, {
          type: 'roster',
          hlcMs: ada.clock.ms,
          body: { rv: 9, action: 'zap' },
        });
      });
      const op = zap as unknown as FederatedOp;
      await quiesce([ada, cy]);
      const paused = (await problemsOf(cy)).find((p) =>
        p.message.includes(`roster op at seq ${op.seq}`)
      );
      expect(paused?.message).toContain(
        `${await ada.handle.replica()} can dismiss`
      );
      const id = await cy.handle.create('while paused');
      await quiesce([ada, cy]);
      expect(await ada.handle.title(id)).toBeNull();
      const dismissed = await ada.handle.api('/api/team/dismiss', {
        method: 'POST',
        body: JSON.stringify({
          replica: bobReplica,
          seq: op.seq,
          hash: opHash(op),
        }),
      });
      expect(dismissed.status).toBe(200);
      await quiesce([ada, cy]);
      expect(await ada.handle.title(id)).toBe('while paused');
      for (const m of [ada, cy]) {
        const notes = (await problemsOf(m)).map((p) => p.message);
        expect(notes.some((n) => n.includes('cannot read'))).toBe(false);
        expect(
          notes.some((n) => n.includes(`dismissed ${bobReplica}'s roster op`))
        ).toBe(true);
        expect(auditKindsOf(m)).toContain('dismiss');
      }
      await expectConverged([ada, cy], [boardProjection, rosterProjection]);
    },
    SLOW
  );

  // FW-R24 (the final review's R1): a key op under each member's id, signed
  // by a key its publisher made, halts nobody and splits no roster.
  it(
    'reads past rival key ops for existing ids, and a later joiner converges',
    async () => {
      const c = await team(['ada', 'bob']);
      const [ada, bob] = c.members as [Member, Member];
      const ids = [await ada.handle.replica(), await bob.handle.replica()];
      editRemote(c.remote, (dir) => {
        for (const r of ids) {
          const k = generateReplicaKeys();
          const op = buildOp(
            {
              replica: r,
              seq: 1,
              prev: ZERO_HASH,
              hlc: `${String(ada.clock.ms).padStart(13, '0')}.0000.${r}`,
              type: 'key',
              body: {
                handle: 'mallory',
                device: 'x',
                build: '0',
                signPub: k.signPub,
                sealPub: k.sealPub,
                legacy: null,
              },
            },
            k.signPriv
          );
          mkdirSync(join(dir, 'fed', r), { recursive: true });
          writeFileSync(
            join(dir, 'fed', r, '000000000900.jsonl'),
            `${JSON.stringify(op)}\n`
          );
        }
      });
      await quiesce([ada, bob]);
      const cy = await c.add('cy');
      await quiesce(c.members);
      await ada.handle.admit(cy.handle);
      await quiesce(c.members);
      const id = await bob.handle.create('seen by cy');
      await quiesce(c.members);
      expect(await cy.handle.title(id)).toBe('seen by cy');
      for (const m of c.members)
        for (const r of ids)
          expect((await halted(m, r)).includes('fails verification')).toBe(
            false
          );
      await expectConverged(c.members, [boardProjection, rosterProjection]);
    },
    SLOW
  );

  // FW-R25 (the final review's R2): a line appended to a member's segment
  // must not lock it out of publishing.
  it(
    'publishes again after someone appends to its segment on the branch',
    async () => {
      const c = await team(['ada', 'bob']);
      const [ada, bob] = c.members as [Member, Member];
      const bobId = await bob.handle.replica();
      await bob.handle.create('local one');
      editRemote(c.remote, (dir) => {
        const d = join(dir, 'fed', bobId);
        const last =
          readdirSync(d)
            .filter((n) => n.endsWith('.jsonl'))
            .sort()
            .at(-1) ?? '';
        appendFileSync(join(d, last), '{"junk":1}\n');
      });
      const id = await bob.handle.create('after the append');
      await quiesce(c.members);
      expect(await ada.handle.title(id)).toBe('after the append');
      const status = (await bob.handle.api('/api/board-sync')).body as {
        pending: number;
        lastError: string | null;
      };
      expect(status).toMatchObject({ pending: 0, lastError: null });
      expect(
        (await problemsOf(bob)).some((p) => p.subject === 'transport:merge')
      ).toBe(true);
      await expectConverged(c.members, [boardProjection]);
    },
    SLOW
  );

  // FW-R25 (the final review's R6): the branch's own .gitattributes and
  // .lfsconfig never change how the clone reads or writes its files.
  it(
    'keeps converging when the branch carries hostile .gitattributes and .lfsconfig',
    async () => {
      const c = await team(['ada', 'bob']);
      const [ada, bob] = c.members as [Member, Member];
      editRemote(c.remote, (dir) => {
        // The attacker's own clone leaves its files as they are.
        writeFileSync(
          join(dir, '.git', 'info', 'attributes'),
          '* -text -eol -filter -merge -diff -working-tree-encoding\n'
        );
        writeFileSync(
          join(dir, '.gitattributes'),
          '* filter=lfs diff=lfs merge=lfs -text\nfed/** working-tree-encoding=UTF-16LE text\nops/** eol=crlf\n'
        );
        writeFileSync(
          join(dir, '.lfsconfig'),
          '[lfs]\n\turl = http://127.0.0.1:9/nowhere\n'
        );
      });
      await quiesce(c.members);
      const fromBob = await bob.handle.create('after the attributes');
      const fromAda = await ada.handle.create('from ada too');
      await quiesce(c.members);
      expect(await ada.handle.title(fromBob)).toBe('after the attributes');
      expect(await bob.handle.title(fromAda)).toBe('from ada too');
      await expectConverged(c.members, [boardProjection]);
    },
    SLOW
  );

  // FW-R25 (the final review's R4): many junk replica directories cost a
  // pass no more than its global read budget, and convergence carries on.
  it(
    'reads no more than its pass budget past junk replica directories',
    async () => {
      const c = await team(['ada', 'bob']);
      const [ada, bob] = c.members as [Member, Member];
      const junk = `${'x'.repeat(1023)}\n`.repeat(1024);
      editRemote(c.remote, (dir) => {
        for (let n = 0; n < 40; n++) {
          const id = `mal-${String(n).padStart(8, '0')}`;
          mkdirSync(join(dir, 'fed', id), { recursive: true });
          writeFileSync(join(dir, 'fed', id, '000000000001.jsonl'), junk);
        }
      });
      // The first pass after the junk lands is the one that would read it all.
      const first = (await ada.handle.sync()).body as {
        transportHealth: { readBytes: number };
      };
      expect(first.transportHealth.readBytes).toBeLessThan(4 * 1024 * 1024);
      const id = await bob.handle.create('past the junk');
      await quiesce(c.members);
      expect(await ada.handle.title(id)).toBe('past the junk');
      expect(
        (await ada.handle.keys()).waiting.some((w) =>
          w.replica.startsWith('mal-')
        )
      ).toBe(false);
    },
    SLOW
  );

  it(
    'keeps a v1 daemon seeing the board through the window, both ways',
    async () => {
      let old: LegacyClient | null = null;
      const { members } = await team(['ada', 'bob'], undefined, async (c) => {
        old = await legacy(c, 'old');
        await old.create('from the old build, before the founding');
      });
      const [ada, bob] = members as [Member, Member];
      const v1 = old as unknown as LegacyClient;
      const fromOld = await v1.create('from the old build, in the window');
      const fromAda = await ada.handle.create('signed, from ada');
      await quiesce(members);
      await v1.pull();
      expect(await bob.handle.title(fromOld)).toBe(
        'from the old build, in the window'
      );
      expect(v1.title(fromAda)).toBe('signed, from ada');
      await expectConverged(members, [boardProjection]);
    },
    SLOW
  );

  it(
    'refuses the legacy replica after the window closes, and a late joiner never sees its later edits',
    async () => {
      let old: LegacyClient | null = null;
      const c = await team(['ada', 'bob'], undefined, async (cl) => {
        old = await legacy(cl, 'old');
        await old.create('attested');
      });
      const v1 = old as unknown as LegacyClient;
      advance(c.members, 31 * 24 * 60 * 60 * 1000);
      await quiesce(c.members);
      const late = await v1.create('after the close');
      await quiesce(c.members);
      for (const m of c.members) {
        expect(await m.handle.title(late)).toBeNull();
        expect(
          (await problemsOf(m)).filter((p) =>
            p.message.includes('its changes are refused')
          )
        ).toHaveLength(1);
      }
      const dee = await c.add('dee');
      const [ada] = c.members as [Member];
      await ada.handle.admit(dee.handle);
      await quiesce(c.members);
      expect(await dee.handle.title(late)).toBeNull();
      await expectConverged(c.members, [boardProjection]);
    },
    SLOW
  );

  it(
    'lists the tasks of a legacy line a replica applied before the close reached it (the closing race)',
    async () => {
      let old: LegacyClient | null = null;
      const { members } = await team(['ada', 'bob'], undefined, async (c) => {
        old = await legacy(c, 'old');
        await old.create('attested');
      });
      const [ada, bob] = members as [Member, Member];
      const v1 = old as unknown as LegacyClient;
      await ada.handle.sync();
      ada.handle.partition(true);
      const raced = await v1.create('written after the closer pulled');
      await bob.handle.sync();
      expect(await bob.handle.title(raced)).toBe(
        'written after the closer pulled'
      );
      await ada.handle.api('/api/team/close-legacy', {
        method: 'POST',
        body: '{}',
      });
      ada.handle.partition(false);
      await quiesce(members);
      expect(
        (await problemsOf(bob)).some(
          (p) =>
            p.subject === `team:race:${v1.replica}` && p.message.includes(raced)
        )
      ).toBe(true);
      expect(await ada.handle.title(raced)).toBeNull();
    },
    SLOW
  );

  it(
    'lists the tasks a revoked replica touched above the cut on a replica that applied them first (the revocation race)',
    async () => {
      const { members } = await team(['ada', 'bob', 'cy']);
      const [ada, bob, cy] = members as [Member, Member, Member];
      ada.handle.partition(true);
      const id = await bob.handle.create('raced');
      await bob.handle.sync();
      await cy.handle.sync();
      const bobReplica = await bob.handle.replica();
      // Ada cannot pull first, so her cut sits below bob's new op.
      const revoked = await ada.handle.api(
        `/api/team/keys/${bobReplica}/revoke`,
        {
          method: 'POST',
          body: '{}',
        }
      );
      expect(revoked.status).toBe(200);
      ada.handle.partition(false);
      await quiesce(members);
      expect(await cy.handle.title(id)).toBe('raced');
      expect(
        (await problemsOf(cy)).some(
          (p) =>
            p.subject === `team:race:${bobReplica}` && p.message.includes(id)
        )
      ).toBe(true);
      expect(await ada.handle.title(id)).toBeNull();
    },
    SLOW
  );

  it(
    "re-issues an older build's edit on a founded root with no chain failure",
    async () => {
      const { members } = await team(['ada', 'bob']);
      const [ada, bob] = members as [Member, Member];
      const id = await ada.handle.create('before the old build ran');
      await quiesce(members);
      const adaReplica = await ada.handle.replica();
      await ada.handle.stop();
      await olderBuildEdit(ada, id, { title: 'from the installed app' });
      await ada.handle.restart();
      await quiesce(members);
      expect(
        bob.handle.stateDb<{ halted: string | null }>(
          'SELECT halted FROM fed_cursors WHERE replica = ?',
          [adaReplica]
        )[0]?.halted
      ).toBeNull();
      expect(await bob.handle.title(id)).toBe('from the installed app');
      const meta = (table: string, key: string) =>
        ada.handle.stateDb<{ value: string }>(
          `SELECT value FROM ${table} WHERE key = ?`,
          [key]
        )[0]?.value;
      expect(meta('fed_meta', 'seq_seen')).toBe(meta('meta', 'seq'));
    },
    SLOW
  );

  it(
    'keeps ada admin through a backdated counter-revocation and a mutual one',
    async () => {
      const { members, remote } = await team(['ada', 'bob', 'cy']);
      const [ada, bob, cy] = members as [Member, Member, Member];
      // Bob's last op so far is at the base time; his promotion comes later.
      advance(members, 60_000);
      const promotedAt = ada.clock.ms;
      const bobReplica = await bob.handle.replica();
      await ada.handle.api(`/api/team/keys/${bobReplica}/role`, {
        method: 'POST',
        body: JSON.stringify({ role: 'admin' }),
      });
      await quiesce(members);
      // Nothing more from bob's own daemon, so the forged op cannot fork his log.
      await bob.handle.stop();
      const adaReplica = await ada.handle.replica();
      const adaHead = ada.handle.stateDb<{ key: string; value: string }>(
        "SELECT key, value FROM fed_meta WHERE key IN ('head_seq', 'head_hash')"
      );
      const head = (key: string) =>
        adaHead.find((r) => r.key === key)?.value ?? '';
      editRemote(remote, (dir) => {
        // Chained validly on bob's log, but positioned before his promotion.
        appendSignedOp(dir, bob, {
          type: 'roster',
          hlcMs: promotedAt - 30_000,
          body: {
            rv: 1,
            action: 'revoke',
            replica: adaReplica,
            afterSeq: Number(head('head_seq')),
            afterHash: head('head_hash'),
            reason: 'backdated',
          },
        });
      });
      await ada.handle.api(`/api/team/keys/${bobReplica}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'mutual' }),
      });
      await quiesce([ada, cy]);
      for (const m of [ada, cy]) {
        const roster = (await m.handle.keys()).roster;
        expect(roster.find((r) => r.replica === adaReplica)?.role).toBe(
          'admin'
        );
        expect(roster.map((r) => r.handle)).not.toContain('bob');
      }
      await expectConverged([ada, cy], [rosterProjection]);
    },
    SLOW
  );

  it(
    'lets a new machine rejoin as an admin with the recovery code once every admin machine is lost',
    async () => {
      const c = await cluster(['ada', 'bob']);
      stop = c.stop;
      const [ada, bob] = c.members as [Member, Member];
      const { recoveryCode } = await ada.handle.found();
      await quiesce(c.members);
      await ada.handle.admit(bob.handle);
      await quiesce(c.members);
      await ada.handle.stop();
      const ada2 = await c.add('ada2', { gitName: 'ada' });
      await quiesce([bob, ada2]);
      const recovered = await ada2.handle.api('/api/team/recover', {
        method: 'POST',
        body: JSON.stringify({ code: recoveryCode }),
      });
      expect(recovered.status).toBe(200);
      await quiesce([bob, ada2]);
      const replica = await ada2.handle.replica();
      for (const m of [bob, ada2])
        expect(
          (await m.handle.keys()).roster.find((r) => r.replica === replica)
        ).toMatchObject({ role: 'admin', recovered: true });
    },
    SLOW
  );

  it(
    'converges with a clock 30 seconds ahead and holds nothing',
    async () => {
      const { members } = await team(['ada', 'bob']);
      const [ada, bob] = members as [Member, Member];
      bob.clock.ms += 30_000;
      const id = await bob.handle.create('slightly ahead');
      await quiesce(members);
      expect(await ada.handle.title(id)).toBe('slightly ahead');
      expect(auditKindsOf(ada)).not.toContain('clock-hold');
    },
    SLOW
  );

  it(
    "holds a clock 10 minutes ahead until this machine's clock catches up",
    async () => {
      const { members } = await team(['ada', 'bob']);
      const [ada, bob] = members as [Member, Member];
      bob.clock.ms += 600_000;
      const id = await bob.handle.create('from the future');
      await quiesce(members);
      expect(await ada.handle.title(id)).toBeNull();
      ada.clock.ms += 600_000;
      await quiesce(members);
      expect(await ada.handle.title(id)).toBe('from the future');
      await expectConverged(members, [boardProjection]);
    },
    SLOW
  );
});
