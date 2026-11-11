import { describe, expect, test } from 'bun:test';

import { CLAIM_GRACE_MS, STALL_MS, TeamHub } from '../src/hub.js';
import { openHubDb } from '../src/schema.js';
import type { Command, HubEvent, SessionBeat } from '../src/types.js';

const START = Date.parse('2026-11-11T17:00:00.000Z');
const ALICE = { actor: 'human:alice', machine: 'alice-mbp' };
const BOB = { actor: 'human:bob', machine: 'bob-mbp' };
const P = 'dispatch';

// A hub on an in-memory database with a clock the test moves by hand.
function setup(mintId?: (taken: string) => string) {
  const clock = { at: START };
  const hub = new TeamHub(openHubDb(':memory:'), {
    now: () => clock.at,
    ...(mintId === undefined ? {} : { mintId }),
  });
  const events: HubEvent[] = [];
  hub.subscribe((event) => events.push(event));
  let n = 0;
  const cid = () => `c${++n}`;
  const create = (id: string, fields = {}) =>
    hub.apply(ALICE, {
      cid: cid(),
      type: 'task.create',
      project: P,
      id,
      fields,
    });
  return { hub, clock, events, cid, create };
}

function session(id: string, over: Partial<SessionBeat> = {}): SessionBeat {
  return {
    id,
    kind: 'session',
    actor: `agent:alice/${id}`,
    project: P,
    branch: 'main',
    task: null,
    state: 'working',
    waitingOn: null,
    label: null,
    ...over,
  };
}

describe('tasks', () => {
  test('a create is ordered, stored and broadcast', () => {
    const { hub, events, create } = setup();
    const ack = create('t-1', { title: 'Claims', status: 'ready' });
    expect(ack).toEqual({ cid: 'c1', ok: true, seq: 1 });
    expect(events.map((e) => [e.seq, e.type, e.actor])).toEqual([
      [1, 'task.created', 'human:alice'],
    ]);
    expect(hub.snapshot().tasks[0]?.fields['status']).toEqual({
      value: 'ready',
      rev: 1,
      actor: 'human:alice',
    });
  });

  test('a resent command is applied once and answered the same', () => {
    const { hub, events } = setup();
    const command: Command = {
      cid: 'same',
      type: 'task.create',
      project: P,
      id: 't-1',
      fields: {},
    };
    const first = hub.apply(ALICE, command);
    expect(hub.apply(ALICE, command)).toEqual(first);
    expect(events).toHaveLength(1);
    expect(hub.snapshot().tasks).toHaveLength(1);
  });

  test('a taken id is renamed, not refused', () => {
    const { hub, create, cid } = setup(() => 't-fresh');
    create('t-1');
    const ack = hub.apply(BOB, {
      cid: cid(),
      type: 'task.create',
      project: P,
      id: 't-1',
      fields: { title: "Bob's" },
    });
    expect(ack).toMatchObject({ ok: true, renamed: 't-fresh' });
    expect(hub.snapshot().tasks.map((t) => t.id)).toEqual(['t-1', 't-fresh']);
  });

  test('an offline edit loses to a later one and is told what won', () => {
    const { hub, create, cid } = setup();
    create('t-9', { status: 'ready', title: 'Old' });
    // Bob, online, moves the task on.
    hub.apply(BOB, {
      cid: cid(),
      type: 'task.set',
      project: P,
      id: 't-9',
      fields: { status: 'done' },
      base: { status: 1 },
    });
    // Alice's queued edit still names the rev she saw before Bob's.
    const ack = hub.apply(ALICE, {
      cid: cid(),
      type: 'task.set',
      project: P,
      id: 't-9',
      fields: { status: 'review' },
      base: { status: 1 },
    });
    expect(ack).toEqual({
      cid: 'c3',
      ok: false,
      why: 'stale',
      stale: { status: { value: 'done', rev: 2, actor: 'human:bob' } },
    });
    expect(hub.snapshot().tasks[0]?.fields['status']?.value).toBe('done');
  });

  test('a set applies its fresh fields and reports its stale ones', () => {
    const { hub, events, create, cid } = setup();
    create('t-9', { status: 'ready', title: 'Old' });
    hub.apply(BOB, {
      cid: cid(),
      type: 'task.set',
      project: P,
      id: 't-9',
      fields: { status: 'done' },
    });
    const ack = hub.apply(ALICE, {
      cid: cid(),
      type: 'task.set',
      project: P,
      id: 't-9',
      fields: { status: 'review', title: 'New' },
      base: { status: 1, title: 1 },
    });
    expect(ack).toMatchObject({ ok: true, seq: 3 });
    expect(ack.ok && ack.stale?.['status']?.value).toBe('done');
    expect(events.at(-1)).toMatchObject({
      type: 'task.changed',
      fields: { title: 'New' },
    });
  });

  test('setting a field to the value it holds raises no event', () => {
    const { hub, events, create, cid } = setup();
    create('t-1', { status: 'ready' });
    const ack = hub.apply(BOB, {
      cid: cid(),
      type: 'task.set',
      project: P,
      id: 't-1',
      fields: { status: 'ready' },
    });
    expect(ack).toEqual({ cid: 'c2', ok: true, seq: 1 });
    expect(events).toHaveLength(1);
  });

  test('appends are always accepted and kept in order', () => {
    const { hub, create, cid } = setup();
    create('t-1');
    for (const [who, text] of [
      [ALICE, 'first'],
      [BOB, 'second'],
    ] as const)
      hub.apply(who, {
        cid: cid(),
        type: 'task.append',
        project: P,
        id: 't-1',
        kind: 'comment',
        entry: text,
      });
    expect(hub.snapshot().tasks[0]?.entries).toEqual([
      { seq: 2, kind: 'comment', entry: 'first' },
      { seq: 3, kind: 'comment', entry: 'second' },
    ]);
  });

  test('a removed task refuses later writes and frees its id for nobody', () => {
    const { hub, create, cid } = setup(() => 't-other');
    create('t-1');
    hub.apply(ALICE, {
      cid: cid(),
      type: 'task.remove',
      project: P,
      id: 't-1',
    });
    const late = hub.apply(BOB, {
      cid: cid(),
      type: 'task.set',
      project: P,
      id: 't-1',
      fields: { status: 'done' },
    });
    expect(late).toMatchObject({ ok: false, why: 'unknown-task' });
    expect(create('t-1')).toMatchObject({ ok: true, renamed: 't-other' });
  });
});

describe('claims', () => {
  const claim = (
    t: ReturnType<typeof setup>,
    who: typeof ALICE,
    task: string,
    sessionId: string,
    writes: string[]
  ) =>
    t.hub.apply(who, {
      cid: t.cid(),
      type: 'claim',
      project: P,
      task,
      session: sessionId,
      writes,
    });

  function board() {
    const t = setup();
    t.create('t-12');
    t.create('t-15');
    t.create('t-20');
    t.hub.beat(ALICE.machine, [session('a1')]);
    t.hub.beat(BOB.machine, [session('b1', { actor: 'agent:bob/b1' })]);
    return t;
  }

  test('the first claim wins and the second is told who holds it', () => {
    const t = board();
    expect(claim(t, ALICE, 't-12', 'a1', ['src/team/**'])).toMatchObject({
      ok: true,
    });
    expect(claim(t, BOB, 't-12', 'b1', ['docs/**'])).toMatchObject({
      ok: false,
      why: 'held',
      holder: { session: 'a1', machine: 'alice-mbp', actor: 'agent:alice/a1' },
    });
  });

  test('a claim whose paths overlap another task is refused with the paths', () => {
    const t = board();
    claim(t, ALICE, 't-12', 'a1', ['src/team/**']);
    expect(
      claim(t, BOB, 't-15', 'b1', ['src/team/routes.ts', 'docs/a.md'])
    ).toMatchObject({
      ok: false,
      why: 'overlap',
      holder: { task: 't-12', paths: ['src/team/routes.ts'] },
    });
    expect(claim(t, BOB, 't-20', 'b1', ['docs/**'])).toMatchObject({
      ok: true,
    });
  });

  test('a claim with no paths holds only its task', () => {
    const t = board();
    claim(t, ALICE, 't-12', 'a1', []);
    expect(claim(t, BOB, 't-15', 'b1', ['src/**'])).toMatchObject({ ok: true });
  });

  test('claiming needs a live session on the same machine', () => {
    const t = board();
    expect(claim(t, BOB, 't-12', 'a1', [])).toMatchObject({
      ok: false,
      why: 'unknown-session',
    });
  });

  test('the holder can widen its claim; only the holder can release it', () => {
    const t = board();
    claim(t, ALICE, 't-12', 'a1', ['src/a.ts']);
    expect(
      claim(t, ALICE, 't-12', 'a1', ['src/a.ts', 'src/b.ts'])
    ).toMatchObject({ ok: true });
    expect(t.hub.snapshot().claims[0]?.writes).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
    const release = (who: typeof ALICE, sessionId: string) =>
      t.hub.apply(who, {
        cid: t.cid(),
        type: 'release',
        project: P,
        task: 't-12',
        session: sessionId,
      });
    expect(release(BOB, 'b1')).toMatchObject({ ok: false, why: 'not-holder' });
    expect(release(ALICE, 'a1')).toMatchObject({ ok: true });
    expect(claim(t, BOB, 't-12', 'b1', [])).toMatchObject({ ok: true });
  });
});

describe('sessions', () => {
  test('a beat raises an event only when something changed', () => {
    const { hub, events, clock } = setup();
    hub.beat(ALICE.machine, [session('a1')]);
    clock.at += 30_000;
    hub.beat(ALICE.machine, [session('a1')]);
    expect(events).toHaveLength(1);
    hub.beat(ALICE.machine, [
      session('a1', { state: 'waiting', waitingOn: 'gate-7' }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'session.changed',
      session: { id: 'a1', state: 'waiting', waitingOn: 'gate-7' },
    });
  });

  test('a silent session stalls, keeps its claim for the grace, then loses it', () => {
    const { hub, events, clock, create, cid } = setup();
    create('t-12');
    hub.beat(ALICE.machine, [session('a1')]);
    hub.apply(ALICE, {
      cid: cid(),
      type: 'claim',
      project: P,
      task: 't-12',
      session: 'a1',
      writes: [],
    });

    clock.at += STALL_MS + 1;
    hub.sweep();
    expect(hub.snapshot().sessions[0]?.state).toBe('stalled');
    expect(hub.snapshot().claims).toHaveLength(1);

    clock.at += CLAIM_GRACE_MS;
    hub.sweep();
    expect(hub.snapshot().claims).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      type: 'claim.released',
      task: 't-12',
      reason: 'expired',
    });
  });

  test('a stalled session that beats again is live and keeps its claim', () => {
    const { hub, clock, create, cid } = setup();
    create('t-12');
    hub.beat(ALICE.machine, [session('a1')]);
    hub.apply(ALICE, {
      cid: cid(),
      type: 'claim',
      project: P,
      task: 't-12',
      session: 'a1',
      writes: [],
    });
    clock.at += STALL_MS + 1;
    hub.sweep();
    hub.beat(ALICE.machine, [session('a1')]);
    clock.at += CLAIM_GRACE_MS;
    hub.beat(ALICE.machine, [session('a1')]);
    hub.sweep();
    expect(hub.snapshot().sessions[0]?.state).toBe('working');
    expect(hub.snapshot().claims).toHaveLength(1);
  });

  test('a session its machine stops listing ends and frees its claim at once', () => {
    const { hub, events, create, cid } = setup();
    create('t-12');
    hub.beat(ALICE.machine, [session('a1'), session('a2')]);
    hub.apply(ALICE, {
      cid: cid(),
      type: 'claim',
      project: P,
      task: 't-12',
      session: 'a1',
      writes: [],
    });
    hub.beat(ALICE.machine, [session('a2')]);
    expect(hub.snapshot().sessions.map((s) => s.id)).toEqual(['a2']);
    expect(hub.snapshot().claims).toHaveLength(0);
    expect(events.slice(-2).map((e) => e.type)).toEqual([
      'session.changed',
      'claim.released',
    ]);
  });
});

describe('the log', () => {
  test('an edge catches up from its cursor, a page at a time', () => {
    const { hub, create } = setup();
    for (const id of ['t-1', 't-2', 't-3']) create(id);
    const page = hub.eventsAfter(1, 1);
    expect(page.events.map((e) => e.seq)).toEqual([2]);
    expect(page.more).toBe(true);
    expect(hub.eventsAfter(2).events.map((e) => e.seq)).toEqual([3]);
    expect(hub.eventsAfter(3)).toEqual({ events: [], more: false });
  });

  test('a snapshot names the seq the events continue from', () => {
    const { hub, create } = setup();
    create('t-1');
    hub.beat(ALICE.machine, [session('a1')]);
    expect(hub.snapshot().seq).toBe(hub.head());
    expect(hub.head()).toBe(2);
  });
});
