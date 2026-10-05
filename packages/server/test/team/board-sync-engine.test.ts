import type { TaskDoc, UpdatePatch } from '@dispatch-foo/core';
import { applyUpdatePatch, newTaskDoc } from '@dispatch-foo/core';
import { describe, expect, test } from 'bun:test';

import type { BoardOp, MergeState } from '../../src/team/boardSync/engine.js';
import {
  applyOp,
  diffTask,
  HybridClock,
  memoryMergeState,
  recordLocal,
  taskFields,
} from '../../src/team/boardSync/engine.js';

// One replica as the sync layer sees it: a board, what it knows about how the
// board got that way, a clock, and the log of changes it made itself.
class Replica {
  readonly board = new Map<string, TaskDoc>();
  readonly state: MergeState = memoryMergeState();
  readonly clock: HybridClock;
  readonly log: BoardOp[] = [];
  readonly problems: string[] = [];
  private seq = 0;

  constructor(
    readonly name: string,
    now: () => number
  ) {
    this.clock = new HybridClock(name, null, now);
  }

  private commit(before: TaskDoc | null, after: TaskDoc | null, id: string) {
    const change = diffTask(before, after);
    if (change === null) return;
    this.seq += 1;
    const op: BoardOp = {
      v: 1,
      replica: this.name,
      seq: this.seq,
      hlc: this.clock.tick(),
      task: id,
      ...change,
    };
    recordLocal(op, this.state);
    this.log.push(op);
    if (after === null) this.board.delete(id);
    else this.board.set(id, after);
  }

  create(id: string, title: string, created: string) {
    this.commit(null, newTaskDoc(id, 'task', { title }, created), id);
  }

  update(id: string, patch: UpdatePatch) {
    const before = this.board.get(id);
    if (before === undefined) return;
    this.commit(
      before,
      applyUpdatePatch(before, patch, new Date().toISOString()),
      id
    );
  }

  remove(id: string) {
    const before = this.board.get(id);
    if (before === undefined) return;
    this.commit(before, null, id);
  }

  receive(op: BoardOp) {
    if (op.replica === this.name) return;
    this.clock.observe(op.hlc);
    const result = applyOp(op, this.board.get(op.task) ?? null, this.state);
    if (result.problem !== undefined) this.problems.push(result.problem);
    if (!result.changed) return;
    if (result.doc === null) this.board.delete(op.task);
    else this.board.set(op.task, result.doc);
  }

  /** The board as the fields that travel, for comparing replicas. */
  view(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [id, doc] of [...this.board].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      out[id] = taskFields(doc);
    }
    return out;
  }
}

// A clock the test moves by hand, shared so "later" means later everywhere
// unless a test skews one replica on purpose.
function wall(start = 1_790_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms = 1) => void (t += ms) };
}

function deliver(from: Replica, to: Replica) {
  for (const op of from.log) to.receive(op);
}

describe('HybridClock', () => {
  test('never goes backwards, and orders a reply after what it replied to', () => {
    const w = wall();
    const a = new HybridClock('a', null, w.now);
    const b = new HybridClock('b', null, () => w.now() - 60_000); // a minute behind
    const first = a.tick();
    b.observe(first);
    const reply = b.tick();
    expect(reply > first).toBe(true);
    expect(a.tick() > first).toBe(true);
  });

  test('picks up where a persisted reading left off', () => {
    const w = wall();
    const a = new HybridClock('a', null, w.now);
    const last = a.tick();
    const restarted = new HybridClock('a', last, () => w.now() - 5_000);
    expect(restarted.tick() > last).toBe(true);
  });
});

describe('merging', () => {
  test('edits to different fields on two machines both survive', () => {
    const w = wall();
    const a = new Replica('a', w.now);
    const b = new Replica('b', w.now);
    a.create('t-00000001', 'Fix login', '2026-09-23T00:00:00.000Z');
    deliver(a, b);

    w.advance();
    a.update('t-00000001', { status: 'done' });
    w.advance();
    b.update('t-00000001', { labels: ['auth'] });
    deliver(a, b);
    deliver(b, a);

    // The store canonicalizes a status name, so read what A actually holds.
    const status = a.board.get('t-00000001')?.meta.status;
    for (const r of [a, b]) {
      const doc = r.board.get('t-00000001');
      expect(doc?.meta.status).toBe(status);
      expect(doc?.meta.labels).toEqual(['auth']);
    }
    expect(a.view()).toEqual(b.view());
  });

  test('the same field edited on both: the later change wins everywhere', () => {
    const w = wall();
    const a = new Replica('a', w.now);
    const b = new Replica('b', w.now);
    a.create('t-00000001', 'Fix login', '2026-09-23T00:00:00.000Z');
    deliver(a, b);
    w.advance();
    a.update('t-00000001', { title: 'Fix login (A)' });
    w.advance();
    b.update('t-00000001', { title: 'Fix login (B)' });
    deliver(a, b);
    deliver(b, a);
    expect(a.board.get('t-00000001')?.meta.title).toBe('Fix login (B)');
    expect(b.board.get('t-00000001')?.meta.title).toBe('Fix login (B)');
  });

  test('both people’s activity lines survive, in the same order on both', () => {
    const w = wall();
    const a = new Replica('a', w.now);
    const b = new Replica('b', w.now);
    a.create('t-00000001', 'Fix login', '2026-09-23T00:00:00.000Z');
    deliver(a, b);
    w.advance();
    a.update('t-00000001', { appendActivity: 'ada: reproduced it' });
    w.advance();
    b.update('t-00000001', { appendActivity: 'grace: it is the cookie' });
    deliver(a, b);
    deliver(b, a);
    const lines = (r: Replica) =>
      taskFields(r.board.get('t-00000001') as TaskDoc).activity;
    expect(lines(a)).toEqual(lines(b));
    expect(lines(a).join('\n')).toContain('reproduced it');
    expect(lines(a).join('\n')).toContain('it is the cookie');
  });

  test('a delete wins over edits made before it, and loses to one made after', () => {
    const w = wall();
    const a = new Replica('a', w.now);
    const b = new Replica('b', w.now);
    a.create('t-00000001', 'Old', '2026-09-23T00:00:00.000Z');
    a.create('t-00000002', 'Keep me', '2026-09-23T00:00:00.001Z');
    deliver(a, b);

    w.advance();
    b.update('t-00000001', { title: 'Old, edited' }); // before the delete
    w.advance();
    a.remove('t-00000001');
    a.remove('t-00000002');
    w.advance();
    b.update('t-00000002', { title: 'Keep me, edited later' }); // after
    deliver(a, b);
    deliver(b, a);

    for (const r of [a, b]) {
      expect(r.board.has('t-00000001')).toBe(false);
      expect(r.board.get('t-00000002')?.meta.title).toBe(
        'Keep me, edited later'
      );
    }
    expect(a.view()).toEqual(b.view());
  });

  test('applying a change twice is applying it once', () => {
    const w = wall();
    const a = new Replica('a', w.now);
    const b = new Replica('b', w.now);
    a.create('t-00000001', 'Fix login', '2026-09-23T00:00:00.000Z');
    w.advance();
    a.update('t-00000001', { appendActivity: 'once' });
    deliver(a, b);
    const once = b.view();
    deliver(a, b);
    expect(b.view()).toEqual(once);
  });

  test('two machines minting one id for different tasks is reported, not merged', () => {
    const w = wall();
    const a = new Replica('a', w.now);
    const b = new Replica('b', w.now);
    a.create('t-00000001', 'A’s task', '2026-09-23T00:00:00.000Z');
    b.create('t-00000001', 'B’s task', '2026-09-23T00:00:05.000Z');
    deliver(a, b);
    deliver(b, a);
    expect(a.board.get('t-00000001')?.meta.title).toBe('A’s task');
    expect(b.board.get('t-00000001')?.meta.title).toBe('B’s task');
    expect(a.problems[0]).toContain('created separately on two machines');
    expect(b.problems).toHaveLength(1);
  });

  test('two machines importing the same board are one board, not a clash', () => {
    // Both cloned a repo whose markdown board was committed: same ids, same
    // created times. That is one task seen twice, not two tasks.
    const w = wall();
    const a = new Replica('a', w.now);
    const b = new Replica('b', w.now);
    a.create('t-00000001', 'Imported', '2026-01-01T00:00:00.000Z');
    b.create('t-00000001', 'Imported', '2026-01-01T00:00:00.000Z');
    deliver(a, b);
    deliver(b, a);
    expect(a.problems).toEqual([]);
    expect(a.view()).toEqual(b.view());
  });
});

// A seeded generator so a failure here reproduces exactly.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('convergence', () => {
  // The property the whole design rests on: whatever three people do, and
  // whatever order their changes arrive in — shuffled, duplicated, partly
  // delivered and then the rest later — every replica ends on the same board.
  for (const seed of [1, 2, 3, 7, 42, 1234, 99999]) {
    test(`random edits on three machines converge (seed ${seed})`, () => {
      const random = rng(seed);
      const w = wall();
      const replicas = ['a', 'b', 'c'].map((n) => new Replica(n, w.now));
      const ids = ['t-00000001', 't-00000002', 't-00000003', 't-00000004'];
      const statuses = ['ready', 'in-progress', 'in-review', 'done'];

      for (let step = 0; step < 120; step++) {
        w.advance(Math.floor(random() * 3));
        const r = replicas[Math.floor(random() * replicas.length)];
        const id = ids[Math.floor(random() * ids.length)];
        const roll = random();
        if (!r.board.has(id)) {
          if (roll < 0.5)
            r.create(id, `task ${id}`, '2026-09-23T00:00:00.000Z');
        } else if (roll < 0.25) {
          r.update(id, {
            status: statuses[Math.floor(random() * statuses.length)],
          });
        } else if (roll < 0.45) {
          r.update(id, { title: `title ${step}` });
        } else if (roll < 0.65) {
          r.update(id, { appendActivity: `step ${step} by ${r.name}` });
        } else if (roll < 0.8) {
          r.update(id, { description: `description ${step}` });
        } else if (roll < 0.9) {
          r.update(id, { labels: [`l${step % 3}`] });
        } else {
          r.remove(id);
        }
        // Now and then, someone syncs partway through.
        if (random() < 0.2) {
          const from = replicas[Math.floor(random() * replicas.length)];
          const to = replicas[Math.floor(random() * replicas.length)];
          for (const op of from.log.slice(
            0,
            Math.floor(random() * from.log.length)
          )) {
            to.receive(op);
          }
        }
      }

      // Everyone gets everything, in their own shuffled order, some twice.
      const all = replicas.flatMap((r) => r.log);
      for (const r of replicas) {
        for (const op of shuffled([...all, ...all.slice(0, 20)], random)) {
          r.receive(op);
        }
      }

      const [first, ...rest] = replicas.map((r) => r.view());
      for (const other of rest) expect(other).toEqual(first);
    });
  }
});
