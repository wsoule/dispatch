import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultAsyncGitRunner } from '../../../src/sync/worktree.js';
import { LinkHub } from '../../../src/team/links/hub.js';
import { linkReplicaId } from '../../../src/team/links/service.js';
import { runGitSync } from '../../orchestrator/helpers.js';
import { linkKeys, RawPeer, scratch } from './helpers.js';
import type { Scratch } from './helpers.js';

// Each pass runs real git exchanges against a scratch remote.
setDefaultTimeout(120_000);

let s: Scratch;
const hubs: LinkHub[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.stop();
  s.cleanup();
});

const MIB = 1024 * 1024;

function hubOf(over: Partial<ConstructorParameters<typeof LinkHub>[0]> = {}) {
  const keys = linkKeys();
  const hub = new LinkHub({
    dir: join(s.dir, `hub-${hubs.length}`),
    keys,
    paired: () => true,
    serve: () => Promise.resolve(new Response('{}')),
    watch: () => () => {},
    unpaired: () => {},
    keyChange: () => {},
    now: s.now,
    ...over,
  });
  hubs.push(hub);
  return { hub, keys };
}

// A peer branch padded with `mib` MiB of junk under the peer's own files.
function bloat(branch: string, replica: string, mib: number) {
  const dir = join(s.dir, `bloat-${branch}`);
  runGitSync(s.dir, ['clone', '-q', s.remote, dir]);
  runGitSync(dir, ['checkout', '-q', '--orphan', branch]);
  mkdirSync(join(dir, 'fed', replica), { recursive: true });
  const line = `${'q'.repeat(1023)}\n`;
  for (let i = 0; i * MIB < mib * MIB; i++)
    writeFileSync(
      join(
        dir,
        'fed',
        replica,
        `6000000000${String(i).padStart(2, '0')}.jsonl`
      ),
      line.repeat(1024)
    );
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '-q',
    '-m',
    'bloat',
  ]);
  runGitSync(dir, ['push', '-q', 'origin', branch]);
}

describe('LinkHub read budget across links (P-D6)', () => {
  it('caps the reads of all links a pass, round-robin, each within its share', async () => {
    s = scratch();
    const { hub } = hubOf({ linkReadBytes: 1 * MIB, totalReadBytes: 2 * MIB });
    const at = new Date().toISOString();
    for (const n of [1, 2, 3]) {
      const peer = linkKeys();
      const id = `L${n}AAAAAAAAAAAAAAAAAA`;
      const branch = `dispatch-a2a-000000000000000${n}`;
      bloat(branch, linkReplicaId(peer.signPub, id), 3);
      hub.add({
        alias: `p${n}`,
        pairedId: id,
        remote: s.remote,
        branch,
        signPub: peer.signPub,
        sealPub: peer.sealPub,
        createdAt: at,
      });
    }
    const read = new Map<string, number>();
    for (let pass = 0; pass < 3; pass++) {
      await hub.settle();
      const total = hub.health().reduce((sum, h) => sum + h.readThisPass, 0);
      expect(total).toBeLessThanOrEqual(2 * MIB);
      for (const h of hub.health()) {
        expect(h.readThisPass).toBeLessThanOrEqual(1 * MIB);
        read.set(h.alias, (read.get(h.alias) ?? 0) + h.readThisPass);
      }
    }
    // Round-robin: over three passes every link got a turn.
    for (const n of [1, 2, 3])
      expect(read.get(`p${n}`) ?? 0).toBeGreaterThan(0);
  });
});

describe('an accepted link waits for the offerer (one-sided pairing)', () => {
  const add = (
    hub: LinkHub,
    peer: ReturnType<typeof linkKeys>,
    until: number
  ) =>
    hub.add(
      {
        alias: 'ada',
        pairedId: 'L1',
        remote: s.remote,
        branch: 'dispatch-a2a-00000000000000aa',
        signPub: peer.signPub,
        sealPub: peer.sealPub,
        createdAt: new Date(s.clock.ms).toISOString(),
      },
      undefined,
      { pendingUntil: new Date(until).toISOString() }
    );

  it('notes, and stays pending, when no op from the offerer arrives in time', async () => {
    s = scratch();
    const { hub } = hubOf();
    const peer = linkKeys();
    add(hub, peer, s.clock.ms + 20 * 60_000);
    await hub.settle();
    expect(hub.health()[0]).toMatchObject({ pending: true });
    s.clock.ms += 21 * 60_000;
    await hub.settle();
    // N1: noted, and still pending (never disabled) in case it starts late.
    expect(hub.health()[0]).toMatchObject({ pending: true });
    expect(hub.health()[0]?.problems.map((p) => p.subject)).toContain(
      'link-unanswered:L1'
    );
  });

  it('is no longer pending once the offerer’s first op is on the branch', async () => {
    s = scratch();
    const { hub } = hubOf();
    const peer = linkKeys();
    add(hub, peer, s.clock.ms + 20 * 60_000);
    // The offerer's link starts its chain on the same branch.
    const raw = new RawPeer(
      s,
      peer,
      linkReplicaId(peer.signPub, 'L1'),
      'dispatch-a2a-00000000000000aa'
    );
    await raw.write(raw.next({ type: 'key', body: { link: 'L1' } }));
    await hub.settle();
    expect(hub.health()[0]).toMatchObject({ pending: false });
    s.clock.ms += 60 * 60_000;
    await hub.settle();
  });
});

describe('T55 review M5 and M6', () => {
  it('reads an offer branch within its share (M5)', async () => {
    s = scratch();
    const { hub } = hubOf({
      linkReadBytes: 1 * MIB,
      totalReadBytes: 2 * MIB,
      offerState: () => 'offered',
      offerProof: () => ({ ok: false, why: 'test' }),
    });
    const branch = 'dispatch-a2a-00000000000000bb';
    bloat(branch, 'mallory.x-00000000', 4);
    hub.watchOffer({ pairedId: 'O1', alias: 'bob', remote: s.remote, branch });
    await hub.settle();
    const o = hub.offers()[0];
    expect(o?.readThisPass ?? Infinity).toBeLessThanOrEqual(1 * MIB);
  });

  it('caps remote task snapshots per link and prunes finished ones (M6)', async () => {
    s = scratch();
    const { hub, keys } = hubOf({ maxRemoteTasks: 3 });
    const peer = linkKeys();
    const id = 'L6';
    const branch = 'dispatch-a2a-00000000000000cc';
    hub.add({
      alias: 'ada',
      pairedId: id,
      remote: s.remote,
      branch,
      signPub: peer.signPub,
      sealPub: peer.sealPub,
      createdAt: new Date(s.clock.ms).toISOString(),
    });
    const raw = new RawPeer(s, peer, linkReplicaId(peer.signPub, id), branch);
    const to = { to: keys, toReplica: linkReplicaId(keys.signPub, id) };
    const task = (n: number, state: string) => ({
      kind: 'event',
      taskId: `t-${n}`,
      event: {
        task: { id: `t-${n}`, contextId: 'c-1', status: { state } },
      },
    });
    const ops = [raw.next({ type: 'key', body: { link: id } })];
    for (let n = 1; n <= 5; n++)
      ops.push(
        raw.next({ payload: task(n, 'TASK_STATE_WORKING'), ...to }, ops.at(-1))
      );
    await raw.write(...ops);
    await hub.settle();
    expect(hub.health()[0]?.remoteTasks).toBe(3);
    const done = raw.next({ payload: task(9, 'TASK_STATE_COMPLETED'), ...to });
    await raw.write(done);
    await hub.settle();
    expect(hub.snapshot('ada', 't-9')).not.toBeNull();
    s.clock.ms += 2 * 86_400_000;
    await hub.settle();
    expect(hub.snapshot('ada', 't-9')).toBeNull();
  });
});

describe('hub.db from an earlier build', () => {
  it('adds the done column to an older remote_tasks table and keeps working', async () => {
    s = scratch();
    const dir = join(s.dir, 'hub-old');
    mkdirSync(dir, { recursive: true });
    const old = new Database(join(dir, 'hub.db'), { create: true });
    old.exec(
      'CREATE TABLE remote_tasks (alias TEXT NOT NULL, task_id TEXT NOT NULL, json TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (alias, task_id))'
    );
    old.close();
    const { hub } = hubOf({ dir });
    await hub.settle();
    expect(hub.health()).toEqual([]);
  });
});

describe('final review N1: only passes that reached the branch count', () => {
  it('does not note an unreachable link as unanswered', async () => {
    s = scratch();
    const { hub } = hubOf();
    const peer = linkKeys();
    hub.add(
      {
        alias: 'ada',
        pairedId: 'L1',
        remote: join(s.dir, 'missing.git'),
        branch: 'dispatch-a2a-00000000000000aa',
        signPub: peer.signPub,
        sealPub: peer.sealPub,
        createdAt: new Date(s.clock.ms).toISOString(),
      },
      undefined,
      { pendingUntil: new Date(s.clock.ms + 60_000).toISOString() }
    );
    s.clock.ms += 5 * 60_000;
    await hub.settle();
    expect(hub.health()[0]?.problems.map((p) => p.subject)).not.toContain(
      'link-unanswered:L1'
    );
  });
});

describe('final review P1: a link connects only to the address it checked', () => {
  // Real git for local steps; fetch and push are recorded and refused, so
  // nothing leaves the machine.
  function recordingGit(seen: string[][]) {
    return (
      cwd: string,
      args: string[],
      env?: Record<string, string>,
      max?: number
    ) => {
      if (args.includes('fetch') || args.includes('push')) {
        seen.push(args);
        return Promise.resolve({
          status: 128,
          stdout: '',
          stderr: 'fake offline',
        });
      }
      return defaultAsyncGitRunner(cwd, args, env, max);
    };
  }

  it('pins the resolved address, and refuses a host that rebinds to a private one', async () => {
    s = scratch();
    const seen: string[][] = [];
    let answer = ['93.184.216.34'];
    const { hub } = hubOf({
      git: recordingGit(seen),
      lookup: () => Promise.resolve(answer),
      tierOf: () => 'decide',
    });
    const peer = linkKeys();
    hub.add({
      alias: 'ada',
      pairedId: 'L1',
      remote: 'https://links.example/x.git',
      branch: 'dispatch-a2a-00000000000000aa',
      signPub: peer.signPub,
      sealPub: peer.sealPub,
      createdAt: new Date(s.clock.ms).toISOString(),
    });
    await hub.settle();
    expect(seen.length).toBeGreaterThan(0);
    expect(
      seen.every((a) =>
        a.includes('http.curloptResolve=links.example:443:93.184.216.34')
      )
    ).toBe(true);
    seen.length = 0;
    answer = ['10.0.0.5'];
    await hub.settle();
    expect(seen).toEqual([]);
    expect(hub.health()[0]?.problems.map((p) => p.subject)).toContain(
      'link-address:L1'
    );
  });

  it('re-checks an ssh host each pass and refuses it once private', async () => {
    s = scratch();
    const seen: string[][] = [];
    const { hub } = hubOf({
      git: recordingGit(seen),
      lookup: () => Promise.resolve(['10.0.0.5']),
      tierOf: () => 'decide',
    });
    const peer = linkKeys();
    hub.add({
      alias: 'ada',
      pairedId: 'L1',
      remote: 'git@links.example:acme/x.git',
      branch: 'dispatch-a2a-00000000000000aa',
      signPub: peer.signPub,
      sealPub: peer.sealPub,
      createdAt: new Date(s.clock.ms).toISOString(),
    });
    await hub.settle();
    expect(seen).toEqual([]);
    expect(hub.health()[0]?.problems.map((p) => p.subject)).toContain(
      'link-address:L1'
    );
  });
});
