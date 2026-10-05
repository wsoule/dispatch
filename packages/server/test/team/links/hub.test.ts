import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  const failed: string[] = [];
  const hub = new LinkHub({
    dir: join(s.dir, `hub-${hubs.length}`),
    keys: linkKeys(),
    paired: () => true,
    serve: () => Promise.resolve(new Response('{}')),
    watch: () => () => {},
    unpaired: () => {},
    keyChange: () => {},
    pairingFailed: (alias) => failed.push(alias),
    now: s.now,
    ...over,
  });
  hubs.push(hub);
  return { hub, failed };
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

  it('fails the pairing with a visible note when no op from the offerer arrives in time', async () => {
    s = scratch();
    const { hub, failed } = hubOf();
    const peer = linkKeys();
    add(hub, peer, s.clock.ms + 20 * 60_000);
    await hub.settle();
    expect(hub.health()[0]).toMatchObject({ pending: true });
    expect(failed).toEqual([]);
    s.clock.ms += 21 * 60_000;
    await hub.settle();
    expect(failed).toEqual(['ada']);
    expect(hub.health()[0]?.problems.map((p) => p.subject)).toContain(
      'link-unanswered:L1'
    );
  });

  it('is no longer pending once the offerer’s first op is on the branch', async () => {
    s = scratch();
    const { hub, failed } = hubOf();
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
    expect(failed).toEqual([]);
  });
});
