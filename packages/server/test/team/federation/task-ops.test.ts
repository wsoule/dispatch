import { openDispatchDb, SqliteTaskStore } from '@dispatch/core';
import { verifyLog } from '@dispatch/federation';
import { MAX_OP_BYTES } from '@dispatch/protocol/federation';
import { afterEach, describe, expect, it } from 'bun:test';

import { SyncedTaskStore } from '../../../src/team/boardSync/syncedStore.js';
import {
  MAX_TASK_FIELD_BYTES,
  OP_ENVELOPE_BYTES,
  splitChange,
  TaskOpSigner,
  TaskTooLargeError,
} from '../../../src/team/federation/taskOps.js';
import { testReplica } from './helpers/replica.js';
import type { TestReplica } from './helpers/replica.js';

const open: TestReplica[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.close();
});

function synced(founded: boolean) {
  const r = testReplica('ada');
  open.push(r);
  if (founded) r.roster.found('acme');
  const inner = new SqliteTaskStore(r.dir, openDispatchDb(':memory:'));
  const store = new SyncedTaskStore(inner, r.ledger);
  store.setSigner(
    new TaskOpSigner({ ledger: r.ledger, fed: r.fed, roster: r.roster })
  );
  return { r, inner, store };
}
const taskOps = (r: TestReplica) =>
  r.fed.outbox().filter((o) => o.type === 'task');

describe('task ops once a team is founded', () => {
  it('keeps the v1 path before founding', () => {
    const { r, store } = synced(false);
    store.create({ title: 'before' });
    expect(r.ledger.outbox()).toHaveLength(1);
    expect(r.fed.outbox()).toEqual([]);
  });

  it('records a task edit as a signed v2 op on the replica chain', () => {
    const { r, store } = synced(true);
    const doc = store.create({ title: 'Fix the login redirect' });
    store.update(doc.meta.id, { labels: ['auth'] });
    const ops = taskOps(r);
    expect(ops.map((o) => (o.body as { task: string }).task)).toEqual([
      doc.meta.id,
      doc.meta.id,
    ]);
    expect(
      (ops[0]?.body as { origin?: string } | undefined)?.origin
    ).toBeDefined();
    expect(r.ledger.outbox()).toEqual([]);
    expect(
      verifyLog(
        r.fed.replica,
        r.fed.outbox(),
        { head: null, halted: null },
        null
      ).cursor.halted
    ).toBeNull();
  });

  it('splits a change over MAX_OP_BYTES into several ops, each under the cap, clocks recorded as they travel', () => {
    const { r, store } = synced(true);
    const section = (n: number) =>
      `## Part ${n}\n\n${'x'.repeat(400 * 1024)}\n`;
    const doc = store.create({ title: 'big' });
    const created = taskOps(r).length;
    store.update(doc.meta.id, { body: [1, 2, 3].map(section).join('\n') });
    // The update's own ops; the creation before it carries the one origin.
    const ops = taskOps(r).slice(created);
    expect(ops.length).toBeGreaterThan(1);
    for (const op of ops)
      expect(Buffer.byteLength(JSON.stringify(op))).toBeLessThanOrEqual(
        MAX_OP_BYTES
      );
    expect(
      taskOps(r).filter(
        (o) => (o.body as { origin?: string }).origin !== undefined
      )
    ).toHaveLength(1);
    for (const op of ops) {
      for (const field of Object.keys(
        (op.body as { fields?: object }).fields ?? {}
      )) {
        expect(r.ledger.state.field(doc.meta.id, field)?.hlc).toBe(op.hlc);
      }
    }
  });

  it('refuses one field over the cap before anything is written', () => {
    const { r, inner, store } = synced(true);
    // No heading: the whole body is one preamble field.
    const huge = 'y'.repeat(MAX_TASK_FIELD_BYTES + 1);
    expect(() => store.create({ title: 'too big', description: huge })).toThrow(
      expect.objectContaining({ field: 'description' })
    );
    expect(inner.list()).toEqual([]);
    expect(taskOps(r)).toEqual([]);
    const doc = store.create({ title: 'fine' });
    expect(() => store.update(doc.meta.id, { body: huge })).toThrow(
      TaskTooLargeError
    );
    expect(inner.get(doc.meta.id)?.body).not.toBe(huge);
    const oneSection = `## Log\n\n${huge}\n`;
    expect(() => store.update(doc.meta.id, { body: oneSection })).toThrow(
      expect.objectContaining({ field: 'body (section "Log")' })
    );
  });

  it('leaves out a field that reaches the signer over the cap, with a problem, and signs the rest', () => {
    const { r } = synced(true);
    const signer = new TaskOpSigner({
      ledger: r.ledger,
      fed: r.fed,
      roster: r.roster,
    });
    const ops = signer.commit({
      task: 't-00000a01',
      kind: 'put',
      fields: {
        title: 'kept',
        '§h:Amendments': 'q'.repeat(MAX_TASK_FIELD_BYTES + 10),
      },
    });
    expect(
      ops.map((o) => Object.keys((o.body as { fields: object }).fields))
    ).toEqual([['title']]);
    expect(
      r.fed
        .problems()
        .some(
          (p) =>
            p.subject === 'task:t-00000a01' &&
            p.message.includes('§h:Amendments')
        )
    ).toBe(true);
  });
});

describe('splitChange', () => {
  it('packs fields in key order, then Activity lines, and puts origin on the first piece only', () => {
    const budget = 1000;
    const pieces = splitChange(
      {
        task: 't-00000a01',
        kind: 'put',
        origin: '2026-09-26T00:00:00.000Z',
        fields: { b: 'x'.repeat(600), a: 'y'.repeat(600) },
        activity: ['l1', 'l2'],
      },
      budget
    );
    expect(pieces.map((p) => Object.keys(p.fields ?? {}))).toEqual([
      ['a'],
      ['b'],
    ]);
    expect(pieces.at(-1)?.activity).toEqual(['l1', 'l2']);
    expect(pieces.map((p) => p.origin !== undefined)).toEqual([true, false]);
    for (const p of pieces)
      expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThanOrEqual(budget);
    expect(OP_ENVELOPE_BYTES).toBeLessThan(MAX_OP_BYTES);
  });

  it('never splits a removal', () => {
    expect(
      splitChange({ task: 't-00000a01', kind: 'remove' }, 10)
    ).toHaveLength(1);
  });
});
