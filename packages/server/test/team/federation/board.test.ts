import {
  buildOp,
  generateReplicaKeys,
  opHash,
  ZERO_HASH,
} from '@dispatch-foo/protocol/federation';
import type { FederatedOp } from '@dispatch-foo/protocol/federation';
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
  bloatSegments,
  forgeLastTaskLine,
  prependJunk,
  rivalClaimFile,
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
  (await problemsOf(m)).find((p) => p.subject === `halt:${replica}`)?.message ??
  '';

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
          (await problemsOf(m)).filter((p) => p.subject.startsWith('halt:'))
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

  // FW-R28, the re-verify's R11a: one junk line before bob's key op must not
  // hide bob, and with him his revocation of mal, from a new machine.
  it(
    "finds a member's key op behind a junk line, so a new machine keeps his revocation",
    async () => {
      const c = await team(['ada', 'bob', 'mal']);
      const [ada, bob, mal] = c.members as [Member, Member, Member];
      const bobId = await bob.handle.replica();
      const malId = await mal.handle.replica();
      await ada.handle.api(`/api/team/keys/${bobId}/role`, {
        method: 'POST',
        body: JSON.stringify({ role: 'admin' }),
      });
      await quiesce(c.members);
      await bob.handle.api(`/api/team/keys/${malId}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'left' }),
      });
      await quiesce(c.members);
      const fromBob = await bob.handle.create('from bob');
      const late = await mal.handle.create('after the revocation');
      await quiesce(c.members);
      editRemote(c.remote, (dir) => prependJunk(dir, bobId));
      const cy = await c.add('cy');
      await quiesce(c.members);
      await ada.handle.admit(cy.handle);
      await quiesce(c.members);
      expect(await cy.handle.title(fromBob)).toBe('from bob');
      expect(await cy.handle.title(late)).toBeNull();
      expect(
        (await cy.handle.keys()).roster.map((r) => r.replica)
      ).not.toContain(malId);
    },
    SLOW
  );

  // R11b: the same on the founder's segment must not leave a new machine
  // unfounded.
  it(
    "finds the founding behind a junk line in the founder's segment",
    async () => {
      const c = await team(['ada']);
      const [ada] = c.members as [Member];
      const adaId = await ada.handle.replica();
      const teamId = (await ada.handle.keys()).team?.id;
      editRemote(c.remote, (dir) => prependJunk(dir, adaId));
      const cy = await c.add('cy');
      await quiesce(c.members);
      expect((await cy.handle.keys()).team?.id).toBe(teamId);
    },
    SLOW
  );

  // N2, the re-verify's R13: four unnamed claims on a new machine's id are
  // stored first; the admin still admits its real key.
  it(
    'admits a new machine by fingerprint past unnamed claims stored before its key',
    async () => {
      const c = await team(['ada']);
      const [ada] = c.members as [Member];
      const dee = await c.add('dee');
      const deeId = (await dee.handle.keys()).machine.replica;
      dee.handle.partition(true);
      editRemote(c.remote, (dir) => {
        for (let n = 1; n <= 4; n++)
          rivalClaimFile(dir, deeId, `00000000000${n}.jsonl`, ada.clock.ms);
      });
      await quiesce([ada]);
      dee.handle.partition(false);
      await quiesce(c.members);
      // dee announces its key once it chooses the team it follows.
      await dee.handle.choose();
      await quiesce(c.members);
      const { machine } = await dee.handle.keys();
      const admitted = await ada.handle.api(`/api/team/keys/${deeId}/admit`, {
        method: 'POST',
        body: JSON.stringify({ fingerprint: machine.fingerprint }),
      });
      expect([admitted.status, admitted.body?.error]).toEqual([200, undefined]);
    },
    SLOW
  );

  // FW-R29(1), the re-verify's R14b: megabytes of junk in each of an offline
  // revoker's segments, after or before its lines, never hide its revocation.
  for (const where of ['append', 'prepend'] as const)
    it(
      `keeps an offline revoker's revocation past ${where}ed bloat in its segments`,
      async () => {
        const c = await team(['ada', 'bob', 'mal']);
        const [ada, bob, mal] = c.members as [Member, Member, Member];
        const bobId = await bob.handle.replica();
        const malId = await mal.handle.replica();
        await ada.handle.api(`/api/team/keys/${bobId}/role`, {
          method: 'POST',
          body: JSON.stringify({ role: 'admin' }),
        });
        await quiesce(c.members);
        await bob.handle.api(`/api/team/keys/${malId}/revoke`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'left' }),
        });
        await quiesce(c.members);
        await bob.handle.stop();
        const late = await mal.handle.create('after the revocation');
        await quiesce([ada, mal]);
        editRemote(c.remote, (dir) =>
          bloatSegments(dir, bobId, 6 * 1024 * 1024, where)
        );
        const cy = await c.add('cy');
        await quiesce([ada, mal, cy]);
        await ada.handle.admit(cy.handle);
        await quiesce([ada, mal, cy]);
        expect(await cy.handle.title(late)).toBeNull();
        expect(
          (await cy.handle.keys()).roster.map((r) => r.replica)
        ).not.toContain(malId);
        // Named per id once founded, or in the one note before (FW-R30(5)).
        expect(
          (await problemsOf(cy)).some(
            (p) =>
              p.subject.startsWith('transport:bloat:') &&
              p.message.includes(bobId)
          )
        ).toBe(true);
      },
      SLOW
    );

  // FW-R29(2), R11c: a 70 KiB junk first line in the founder's segment, past
  // the probe window, never leaves an invite-less joiner unfounded.
  it(
    "finds the founding past a 70 KiB junk first line in the founder's segment",
    async () => {
      const c = await team(['ada']);
      const [ada] = c.members as [Member];
      const adaId = await ada.handle.replica();
      const teamId = (await ada.handle.keys()).team?.id;
      editRemote(c.remote, (dir) =>
        bloatSegments(dir, adaId, 70 * 1024, 'prepend')
      );
      const cy = await c.add('cy');
      await quiesce(c.members);
      expect((await cy.handle.keys()).team?.id).toBe(teamId);
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
      await expectConverged([bob, ada2], [boardProjection, rosterProjection]);
    },
    SLOW
  );

  // I: two machines edit one field at once, one of them cut off; every
  // machine ends on the same value once they meet.
  it(
    'converges concurrent edits to one task field, including under partition',
    async () => {
      const { members } = await team(['ada', 'bob', 'cy']);
      const [ada, bob, cy] = members as [Member, Member, Member];
      const id = await ada.handle.create('first');
      await quiesce(members);
      await ada.handle.patch(id, { title: 'from ada' });
      await bob.handle.patch(id, { title: 'from bob' });
      await quiesce(members);
      await expectConverged(members, [boardProjection]);
      cy.handle.partition(true);
      advance(members, 1_000);
      await cy.handle.patch(id, { title: 'from cy, offline' });
      await ada.handle.patch(id, { title: 'from ada, later' });
      await quiesce([ada, bob]);
      cy.handle.partition(false);
      await quiesce(members);
      const titles = await Promise.all(members.map((m) => m.handle.title(id)));
      expect(new Set(titles).size).toBe(1);
      await expectConverged(members, [boardProjection]);
    },
    SLOW
  );

  // I: two foundings race on one branch (eve founded too, from a machine of
  // her own); a new machine follows neither until it trusts one.
  it(
    'holds two concurrent foundings until trust, then converges on the trusted one',
    async () => {
      const c = await cluster(['ada', 'cy']);
      stop = c.stop;
      const [ada, cy] = c.members as [Member, Member];
      await ada.handle.found();
      await quiesce([ada]);
      const eve = 'eve-0000000e';
      const k = generateReplicaKeys();
      const hlcAt = (n: number) =>
        `${String(ada.clock.ms).padStart(13, '0')}.000${n}.${eve}`;
      const keyOp = buildOp(
        {
          replica: eve,
          seq: 1,
          prev: ZERO_HASH,
          hlc: hlcAt(0),
          type: 'key',
          body: {
            handle: 'eve',
            device: 'desk',
            build: '0.40.0',
            signPub: k.signPub,
            sealPub: k.sealPub,
            legacy: null,
          },
        },
        k.signPriv
      );
      const found = buildOp(
        {
          replica: eve,
          seq: 2,
          prev: opHash(keyOp),
          hlc: hlcAt(1),
          type: 'roster',
          body: {
            rv: 1,
            action: 'found',
            name: 'rival',
            legacy: [],
            recoveryPub: generateReplicaKeys().signPub,
          },
        },
        k.signPriv
      );
      editRemote(c.remote, (dir) => {
        mkdirSync(join(dir, 'fed', eve), { recursive: true });
        writeFileSync(
          join(dir, 'fed', eve, '000000000001.jsonl'),
          `${JSON.stringify(keyOp)}\n${JSON.stringify(found)}\n`
        );
      });
      // cy's key op waits for a founding to follow, so it never settles
      // before trust; a few passes show it both foundings.
      for (let round = 0; round < 3; round++)
        for (const m of c.members) await m.handle.sync();
      const seen = (await cy.handle.keys()).foundings;
      expect(seen.map((f) => f.replica).sort()).toEqual(
        [await ada.handle.replica(), eve].sort()
      );
      expect((await cy.handle.keys()).team).toBeNull();
      const adaFp = (await ada.handle.keys()).machine.fingerprint;
      const trusted = await cy.handle.api('/api/team/trust', {
        method: 'POST',
        body: JSON.stringify({ fingerprint: adaFp }),
      });
      expect(trusted.status).toBe(200);
      await quiesce(c.members);
      expect((await cy.handle.keys()).team?.founder.fingerprint).toBe(adaFp);
      await ada.handle.admit(cy.handle);
      await quiesce(c.members);
      await expectConverged(c.members, [rosterProjection]);
    },
    SLOW
  );

  // I: a log past one segment's 1,000 ops rolls over, and a machine that
  // joins later reads every segment.
  it(
    'rolls a segment over at 1,000 ops and a later joiner reads them all',
    async () => {
      const c = await team(['ada', 'bob']);
      const [ada] = c.members as [Member];
      const ids: string[] = [];
      for (let n = 0; n < 1001; n++) ids.push(await ada.handle.create(`t${n}`));
      await quiesce(c.members);
      const adaId = await ada.handle.replica();
      const segments = readdirSync(
        join(ada.handle.syncDir, 'repo', 'fed', adaId)
      ).filter((f) => f.endsWith('.jsonl'));
      expect(segments.length).toBeGreaterThan(1);
      const cy = await c.add('cy');
      await quiesce(c.members);
      await ada.handle.admit(cy.handle);
      await quiesce(c.members);
      expect(await cy.handle.title(ids[0] ?? '')).toBe('t0');
      expect(await cy.handle.title(ids[1000] ?? '')).toBe('t1000');
      await expectConverged(c.members, [boardProjection]);
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
