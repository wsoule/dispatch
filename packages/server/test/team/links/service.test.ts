import type { FederatedOp } from '@dispatch/protocol/federation';
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { linkReplicaId } from '../../../src/team/links/service.js';
import { event, pairOf, RawPeer, scratch, send } from './helpers.js';
import type { Scratch, Side } from './helpers.js';

// Each pass runs real git exchanges against a scratch remote.
setDefaultTimeout(60_000);

let s: Scratch;
const open: Side[] = [];
afterEach(() => {
  for (const x of open.splice(0)) x.service.close();
  s.cleanup();
});
function pair() {
  s = scratch();
  const sides = pairOf(s);
  open.push(...sides);
  return sides;
}
const settle = async (...xs: Side[]) => {
  for (let i = 0; i < 2; i++) for (const x of xs) await x.service.sync();
};

describe('LinkService (T53)', () => {
  it('exchanges a sealed send and an event both ways over a bare repo', async () => {
    const [ada, bob] = pair();
    await settle(ada, bob);
    expect(ada.service.publish(send('m-1'))).toBe('published');
    await settle(ada, bob);
    expect(bob.got.map((g) => g.payload.kind)).toEqual(['send']);
    const sent = bob.got[0]?.payload;
    expect(sent?.kind === 'send' && sent.message.messageId).toBe('m-1');
    expect(bob.service.publish(event('2026-10-05T12:00:00Z'))).toBe(
      'published'
    );
    await settle(bob, ada);
    expect(ada.got.map((g) => g.payload.kind)).toEqual(['event']);
    // Sealed: the branch never holds the text in the clear.
    const repo = join(s.dir, 'bob', 'repo', 'fed');
    const text = readdirSync(repo, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => readFileSync(join(d.parentPath, d.name), 'utf8'))
      .join('');
    expect(text).not.toContain('Is /sessions final?');
  });

  it('keeps a payload local until the link is ready, then sends it', async () => {
    const [ada, bob] = pair();
    ada.state.paired = false;
    expect(ada.service.publish(send('early'))).toBe('waiting');
    await settle(ada, bob);
    expect(ada.service.waiting()).toBe(1);
    expect(bob.got).toEqual([]);
    ada.state.paired = true;
    await settle(ada, bob);
    expect(ada.service.waiting()).toBe(0);
    expect(bob.got.map((g) => g.payload.kind)).toEqual(['send']);
  });

  it('waits for the peer keys to be decided before sealing anything', async () => {
    const [ada, bob] = pair();
    ada.state.peer = null;
    expect(ada.service.publish(send('undecided'))).toBe('waiting');
    await settle(ada, bob);
    expect(bob.got).toEqual([]);
    ada.state.peer = bob.keys;
    await settle(ada, bob);
    expect(bob.got).toHaveLength(1);
  });

  it('refuses a payload the receiver would refuse, at the producer', () => {
    const [ada] = pair();
    expect(ada.service.publish({ kind: 'cancel', taskId: '' } as never)).toBe(
      'refused'
    );
  });

  it('holds an op stamped past the clock guard, and the ops behind it', async () => {
    const [ada, bob] = pair();
    await settle(ada, bob);
    const raw = new RawPeer(s, ada.keys);
    raw.ops.push(...ownOps(ada));
    const ahead = raw.next({
      payload: send('ahead') as never,
      to: bob.keys,
      hlcMs: s.clock.ms + 10 * 60 * 1000,
    });
    const behind = raw.next(
      {
        payload: send('behind') as never,
        to: bob.keys,
        hlcMs: s.clock.ms + 11 * 60 * 1000,
      },
      ahead
    );
    await raw.write(ahead, behind);
    await settle(bob);
    expect(bob.got).toEqual([]);
    expect(subjects(bob)).toContain(`link-clock:${raw.replica}`);
    s.clock.ms += 12 * 60 * 1000;
    await settle(bob);
    expect(bob.got.map((g) => g.seq)).toEqual([ahead.seq, behind.seq]);
  });

  it("holds a payload whose own time runs ahead of its op's stamp (one-sided)", async () => {
    const [ada, bob] = pair();
    await settle(ada, bob);
    const later = new Date(s.clock.ms + 30 * 60 * 1000).toISOString();
    ada.service.publish(event(later));
    await settle(ada, bob);
    expect(bob.got).toEqual([]);
    expect(subjects(bob)).toContain(
      `link-clock:${linkReplicaId(ada.keys.signPub)}`
    );
  });

  it('takes a payload whose own time is behind its stamp', async () => {
    const [ada, bob] = pair();
    await settle(ada, bob);
    ada.service.publish(
      event(new Date(s.clock.ms - 60 * 60 * 1000).toISOString())
    );
    await settle(ada, bob);
    expect(bob.got).toHaveLength(1);
  });

  it('prunes acknowledged ops to stubs on both the branch and the own log', async () => {
    const [ada, bob] = pair();
    await settle(ada, bob);
    ada.service.publish(send('m-1'));
    await settle(ada, bob, ada, bob);
    expect(bob.got).toHaveLength(1);
    const dir = join(
      s.dir,
      'ada',
      'repo',
      'fed',
      linkReplicaId(ada.keys.signPub)
    );
    const lines = readdirSync(dir)
      .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n'))
      .filter((l) => l.includes('"a2a"'));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.includes('"pruned":true'))).toBe(true);
  });

  it('parks a payload its handler cannot take yet, and delivers it next pass', async () => {
    const [ada, bob] = pair();
    await settle(ada, bob);
    bob.state.park = true;
    ada.service.publish(send('m-1'));
    await settle(ada, bob);
    expect(bob.got).toEqual([]);
    bob.state.park = false;
    await settle(bob);
    expect(bob.got).toHaveLength(1);
  });
});

function subjects(x: Side): string[] {
  return x.service.problems().map((p) => p.subject);
}

// The ops ada's service has published so far, read off the branch clone.
function ownOps(x: Side) {
  const dir = join(s.dir, x.name, 'repo', 'fed', linkReplicaId(x.keys.signPub));
  return readdirSync(dir)
    .filter((f) => f !== 'acks.json')
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n'))
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as FederatedOp)
    .sort((a, b) => a.seq - b.seq);
}
