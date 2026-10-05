import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import {
  appendFileSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  LINK_READ_BYTES,
  linkReplicaId,
} from '../../../src/team/links/service.js';
import { runGitSync } from '../../orchestrator/helpers.js';
import { linkKeys, pairOf, RawPeer, scratch, send } from './helpers.js';
import type { Scratch, Side } from './helpers.js';

// Each pass runs real git exchanges against a scratch remote.
setDefaultTimeout(60_000);

let s: Scratch;
const open: Side[] = [];
afterEach(() => {
  for (const x of open.splice(0)) x.service.close();
  s.cleanup();
});

// Bob is a real LinkService; ada's side of the link is a raw publisher that
// signs with ada's pinned link key, as a buggy or hostile peer could.
async function setup() {
  s = scratch();
  const [ada, bob] = pairOf(s);
  open.push(ada, bob);
  ada.service.close();
  open.splice(open.indexOf(ada), 1);
  const raw = new RawPeer(s, ada.keys);
  const key = raw.next({ type: 'key', body: { link: 'L1' } });
  await raw.write(key);
  await bob.service.sync();
  return { bob, raw };
}
const subjects = (x: Side) => x.service.problems().map((p) => p.subject);
const commitAll = (dir: string, msg: string) => {
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, [
    '-c',
    'user.name=hostile',
    '-c',
    'user.email=hostile@example.invalid',
    'commit',
    '-q',
    '--no-verify',
    '-m',
    msg,
  ]);
};

describe('LinkService on a hostile branch (T53)', () => {
  it('drops a malformed op with a rolling link-drop note and reads on', async () => {
    const { bob, raw } = await setup();
    const bad = raw.next({ payload: { kind: 'nope' }, to: bob.keys });
    const good = raw.next({ payload: send('m-2') as never, to: bob.keys }, bad);
    await raw.write(bad, good);
    await bob.service.sync();
    expect(subjects(bob)).toContain('link-drop:L1');
    expect(bob.got.map((g) => g.seq)).toEqual([good.seq]);
  });

  it('halts on a fork the publisher signed, with a note that cannot be acknowledged', async () => {
    const { bob, raw } = await setup();
    const one = raw.next({ payload: send('m-1') as never, to: bob.keys });
    await raw.write(one);
    await bob.service.sync();
    expect(bob.got).toHaveLength(1);
    // The publisher rewrites seq 2 and signs a line on from it.
    const dir = join(raw.repo.dir, 'fed', raw.replica);
    const other = raw.next(
      { payload: send('m-1-forked') as never, to: bob.keys },
      raw.ops[0]
    );
    const after = raw.next(
      { payload: send('m-3') as never, to: bob.keys },
      other
    );
    for (const f of readdirSync(dir).filter((n) => n !== 'acks.json')) {
      const text = readFileSync(join(dir, f), 'utf8').replace(
        JSON.stringify(one),
        JSON.stringify(other)
      );
      writeFileSync(join(dir, f), text);
    }
    appendFileSync(
      join(
        dir,
        readdirSync(dir)
          .filter((n) => n !== 'acks.json')
          .sort()
          .at(-1)!
      ),
      `${JSON.stringify(after)}\n`
    );
    commitAll(raw.repo.dir, 'fork');
    await raw.repo.exchange();
    await bob.service.sync();
    const fork = bob.service
      .problems()
      .find((p) => p.subject === 'link-fork:L1');
    expect(fork?.dismissible).toBe(false);
    expect(bob.got).toHaveLength(1);
  });

  it('lists a rival key op and never follows it; the honest chain goes on', async () => {
    const { bob, raw } = await setup();
    const rival = new RawPeer(s, linkKeys());
    await rival.write(rival.next({ type: 'key', body: { link: 'L1' } }));
    const good = raw.next({ payload: send('m-2') as never, to: bob.keys });
    await raw.write(good);
    await bob.service.sync();
    expect(subjects(bob)).toContain('link-rival:L1');
    expect(bob.got.map((g) => g.seq)).toEqual([good.seq]);
  });

  it('skips an oversize line and a symlink, and still reads the chain', async () => {
    const { bob, raw } = await setup();
    const dir = join(raw.repo.dir, 'fed', raw.replica);
    writeFileSync(
      join(dir, '900000000001.jsonl'),
      `${'x'.repeat(1_200_000)}\n`
    );
    symlinkSync('/etc/hosts', join(dir, '900000000002.jsonl'));
    commitAll(raw.repo.dir, 'junk');
    await raw.repo.exchange();
    const good = raw.next({ payload: send('m-2') as never, to: bob.keys });
    await raw.write(good);
    await bob.service.sync();
    expect(bob.got.map((g) => g.seq)).toEqual([good.seq]);
  });

  it('writes its own files afresh when someone changed them', async () => {
    const { bob, raw } = await setup();
    await raw.repo.exchange();
    const mine = join(raw.repo.dir, 'fed', linkReplicaId(bob.keys.signPub));
    const seg = readdirSync(mine).find((n) => n !== 'acks.json');
    if (seg === undefined) throw new Error('no own segment');
    appendFileSync(join(mine, seg), '{"v":2,"tampered":true}\n');
    commitAll(raw.repo.dir, 'tamper');
    await raw.repo.exchange();
    await bob.service.sync();
    expect(subjects(bob)).toContain('transport:rewrite:self');
  });

  it('spends at most its read share on a bloated branch', async () => {
    const { bob, raw } = await setup();
    const dir = join(raw.repo.dir, 'fed', raw.replica);
    const line = `${'y'.repeat(1000)}\n`;
    for (const n of ['800000000001', '800000000002', '800000000003'])
      writeFileSync(join(dir, `${n}.jsonl`), line.repeat(4500));
    commitAll(raw.repo.dir, 'bloat');
    await raw.repo.exchange();
    await bob.service.sync();
    expect(bob.service.health().readBytes).toBeLessThanOrEqual(LINK_READ_BYTES);
    // The chain from the cursor is read first, so honest ops still arrive.
    const good = raw.next({ payload: send('m-2') as never, to: bob.keys });
    await raw.write(good);
    await bob.service.sync();
    expect(bob.got.map((g) => g.seq)).toEqual([good.seq]);
    expect(bob.service.health().readBytes).toBeLessThanOrEqual(LINK_READ_BYTES);
  });
});
