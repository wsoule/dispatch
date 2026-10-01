import { verifyLog } from '@dispatch/federation';
import { fingerprint } from '@dispatch/protocol/federation';
import { afterEach, describe, expect, it } from 'bun:test';

import type { BoardOp } from '../../../src/team/boardSync/engine.js';
import { digestV1, LegacyWindow } from '../../../src/team/federation/legacy.js';
import type { V1Log } from '../../../src/team/federation/legacy.js';
import {
  MAX_TASK_FIELD_BYTES,
  TaskOpSigner,
} from '../../../src/team/federation/taskOps.js';
import { exchange, testReplica } from './helpers/replica.js';
import type { TestReplica } from './helpers/replica.js';
import { MemoryV1 } from './helpers/serviceReplica.js';

const open: TestReplica[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.close();
});
const DAY = 24 * 60 * 60 * 1000;

const v1 = (replica: string, seq: number, task = 't-00000a01'): BoardOp => ({
  v: 1,
  replica,
  seq,
  hlc: `${String(1758880000000 + seq).padStart(13, '0')}.0000.${replica}`,
  task,
  kind: 'put',
  fields: { n: seq },
});

// A window and its signer, wired the way index.ts wires them (each needs the other).
function windowFor(r: TestReplica, log: V1Log): LegacyWindow {
  const ref: { signer: TaskOpSigner | null } = { signer: null };
  const legacy = new LegacyWindow({
    ledger: r.ledger,
    fed: r.fed,
    roster: r.roster,
    log,
    now: () => r.clock.now,
    signer: () => {
      if (ref.signer === null) throw new Error('the signer is not wired');
      return ref.signer;
    },
  });
  ref.signer = new TaskOpSigner({
    ledger: r.ledger,
    fed: r.fed,
    roster: r.roster,
    v1Copy: (op, piece) => legacy.v1Copy(op, piece),
  });
  return legacy;
}

function founded(log: MemoryV1) {
  const ada = testReplica('ada');
  open.push(ada);
  return { ada, legacy: windowFor(ada, log) };
}

describe('attestations', () => {
  it('digest the complete lines in seq order and are stable', () => {
    const ops = [v1('old-00000099', 2), v1('old-00000099', 1)];
    expect(digestV1(ops)).toBe(digestV1([...ops].reverse()));
    const log = new MemoryV1();
    log.files.set('old-00000099', ops);
    const { legacy } = founded(log);
    expect(legacy.attest('old-00000099')).toEqual({
      replica: 'old-00000099',
      throughSeq: 2,
      digest: digestV1(ops),
    });
  });

  it("attests this replica's own unsent v1 changes too, so none is left above its key bound", () => {
    const { ada, legacy } = founded(new MemoryV1());
    ada.ledger.commitLocal(
      { task: 't-00000a01', kind: 'put', fields: { title: 'unsent' } },
      () => {}
    );
    expect(legacy.ownAttestation()?.throughSeq).toBe(1);
  });
});

describe('while the window is open', () => {
  it('queues a v1 copy of each signed task op with the same seq and hlc', () => {
    const log = new MemoryV1();
    const { ada, legacy } = founded(log);
    ada.roster.found('acme', legacy.attestAll());
    const op = ada.fed.append({
      type: 'task',
      body: { task: 't-00000a01', kind: 'put', fields: { a: 1 } },
      alsoV1: (o) =>
        legacy.v1Copy(o, { task: 't-00000a01', kind: 'put', fields: { a: 1 } }),
    });
    expect(ada.ledger.outbox().at(-1)).toMatchObject({
      v: 1,
      seq: op.seq,
      hlc: op.hlc,
      task: 't-00000a01',
    });
  });

  it("applies a known legacy replica's v1 ops, holds an unknown one, and bounds an upgraded one at its key", () => {
    const log = new MemoryV1();
    log.files.set('old-00000099', [v1('old-00000099', 1)]);
    const { ada, legacy } = founded(log);
    ada.roster.found('acme', legacy.attestAll());
    const r = legacy.filterV1([
      v1('old-00000099', 1),
      v1('old-00000099', 2),
      v1('new-00000098', 1),
    ]);
    expect(r.apply.map((o) => [o.replica, o.seq])).toEqual([
      ['old-00000099', 1],
      ['old-00000099', 2],
    ]);
    expect([...r.waiting]).toEqual(['new-00000098']);
    expect(
      ada.fed
        .problems()
        .some((p) =>
          p.message.includes('on an older Dispatch; upgrade it to join')
        )
    ).toBe(true);
  });
});

describe('closing', () => {
  it('lets anyone admitted close it after the deadline, attesting through the last line', () => {
    const log = new MemoryV1();
    log.files.set('old-00000099', [
      v1('old-00000099', 1),
      v1('old-00000099', 2),
    ]);
    const { ada, legacy } = founded(log);
    const bob = testReplica('bob');
    open.push(bob);
    ada.roster.found('acme', legacy.attestAll());
    exchange(ada, bob);
    ada.roster.admit(bob.fed.replica, {
      fingerprint: fingerprint(bob.fed.keys.signPub, bob.fed.keys.sealPub),
    });
    exchange(ada, bob);
    const bobLegacy = windowFor(bob, log);
    expect(bobLegacy.maybeClose()).toBe(false);
    expect(
      bob.fed
        .outbox()
        .some(
          (o) =>
            (o.body as { action?: string } | undefined)?.action ===
            'close-legacy'
        )
    ).toBe(false);
    bob.clock.now = new Date(bob.clock.now.getTime() + 31 * DAY);
    expect(bobLegacy.maybeClose()).toBe(true);
    const close = bob.fed.outbox().at(-1)?.body as {
      action: string;
      entries: { replica: string; throughSeq: number }[];
    };
    expect(close.action).toBe('close-legacy');
    expect(close.entries.map((e) => [e.replica, e.throughSeq])).toEqual([
      ['old-00000099', 2],
    ]);
    // Both clocks are past the deadline; an op stamped a month ahead of Ada's
    // would wait for her clock (FW-R21).
    ada.clock.now = bob.clock.now;
    exchange(ada, bob);
    expect(ada.roster.view()?.legacy.closed?.by).toBe(bob.fed.replica);
  });
});

describe('after closing', () => {
  it('refuses v1 ops above an attested bound, with one problem per replica', () => {
    const log = new MemoryV1();
    log.files.set('old-00000099', [v1('old-00000099', 1)]);
    const { ada, legacy } = founded(log);
    ada.roster.found('acme', legacy.attestAll());
    ada.roster.closeLegacy(legacy.attestAll());
    const r = legacy.filterV1([
      v1('old-00000099', 1),
      v1('old-00000099', 2),
      v1('old-00000099', 3),
    ]);
    expect(r.apply.map((o) => o.seq)).toEqual([1]);
    expect(r.refused.map((o) => o.seq)).toEqual([2, 3]);
    expect(
      ada.fed.problems().filter((p) => p.subject === 'replica:old-00000099')
    ).toHaveLength(1);
  });

  it('reads only the found bound of a v1 file rewritten by hand, with a problem', () => {
    const log = new MemoryV1();
    log.files.set('old-00000099', [
      v1('old-00000099', 1),
      v1('old-00000099', 2),
    ]);
    const { ada, legacy } = founded(log);
    ada.roster.found('acme', legacy.attestAll());
    ada.roster.closeLegacy(legacy.attestAll());
    log.files.set('old-00000099', [
      v1('old-00000099', 1),
      { ...v1('old-00000099', 2), fields: { n: 999 } },
    ]);
    const late = legacy.filterV1(log.readV1('old-00000099'));
    expect(late.apply.map((o) => o.seq)).toEqual([]);
    expect(
      ada.fed.problems().some((p) => p.message.includes('was rewritten'))
    ).toBe(true);
  });
});

describe('an older build on the same root', () => {
  it("re-issues an older build's ops as signed task ops with no chain gap", () => {
    const { ada, legacy } = founded(new MemoryV1());
    ada.roster.found('acme', legacy.attestAll());
    // The older build knows nothing of fed_*: it takes meta.seq + 1 and writes outbox.
    ada.ledger.commitLocal(
      {
        task: 't-00000a01',
        kind: 'put',
        fields: { title: 'from the installed app' },
      },
      () => {}
    );
    const reissued = legacy.reissue();
    expect(reissued).toHaveLength(1);
    expect(
      (reissued[0]?.body as { fields: { title: string } } | undefined)?.fields
        .title
    ).toBe('from the installed app');
    expect(legacy.reissue()).toEqual([]);
    const r = verifyLog(
      ada.fed.replica,
      ada.fed.outbox(),
      { head: null, halted: null },
      null
    );
    expect(r.cursor.halted).toBeNull();
    expect(r.accepted.at(-1)?.entry.seq).toBe(reissued[0]?.seq);
    // Re-issued through the signer: the merge state holds the clock the op travels with.
    expect(ada.ledger.state.field('t-00000a01', 'title')?.hlc).toBe(
      reissued[0]?.hlc
    );
  });

  // FW-R22 I2: the branch is not this root's record. An older build's op
  // already sent (gone from the outbox) is re-issued from this root's own
  // copy, and a line someone wrote into this replica's v1 file is never signed.
  it('re-issues only what this root minted, never a branch line', () => {
    const log = new MemoryV1();
    const { ada, legacy } = founded(log);
    ada.roster.found('acme', legacy.attestAll());
    const sent = ada.ledger.commitLocal(
      { task: 't-00000a03', kind: 'put', fields: { title: 'really minted' } },
      () => {}
    );
    // The older build pushed it and cleared its outbox; the branch was then edited.
    ada.ledger.sent(sent.seq);
    log.files.set(ada.fed.replica, [
      { ...sent, fields: { title: 'forged on the branch' } },
      {
        ...sent,
        seq: sent.seq + 1,
        task: 't-00000bad',
        fields: { title: 'never minted' },
      },
    ]);
    const reissued = legacy.reissue();
    expect(
      reissued.map(
        (o) => (o.body as { fields: { title: string } }).fields.title
      )
    ).toEqual(['really minted']);
  });

  it('re-issues an older build’s op even when an op of this build was minted first', () => {
    const { ada, legacy } = founded(new MemoryV1());
    ada.roster.found('acme', legacy.attestAll());
    ada.ledger.commitLocal(
      { task: 't-00000a04', kind: 'put', fields: { title: 'between passes' } },
      () => {}
    );
    // An admin action through the API mints an op before the pass re-issues.
    ada.roster.invite('bob');
    expect(
      legacy
        .reissue()
        .map((o) => (o.body as { fields: { title: string } }).fields.title)
    ).toEqual(['between passes']);
    expect(legacy.reissue()).toEqual([]);
  });

  it("re-issues an older build's oversized field without it, with a problem, and the rest signed", () => {
    const { ada, legacy } = founded(new MemoryV1());
    ada.roster.found('acme', legacy.attestAll());
    const huge = 'z'.repeat(MAX_TASK_FIELD_BYTES + 1);
    ada.ledger.commitLocal(
      {
        task: 't-00000a02',
        kind: 'put',
        fields: { title: 'old build', '§preamble': huge },
      },
      () => {}
    );
    const reissued = legacy.reissue();
    expect(
      reissued.map((o) => Object.keys((o.body as { fields: object }).fields))
    ).toEqual([['title']]);
    expect(
      ada.fed
        .problems()
        .some(
          (p) =>
            p.subject === 'task:t-00000a02' && p.message.includes('§preamble')
        )
    ).toBe(true);
    expect(legacy.reissue()).toEqual([]);
  });
});

describe('the closing race', () => {
  it('lists the tasks a legacy line touched when this replica applied it before the close arrived', () => {
    const log = new MemoryV1();
    const first = v1('old-00000099', 1);
    log.files.set('old-00000099', [first]);
    const { ada, legacy } = founded(log);
    ada.roster.found('acme', legacy.attestAll());
    // The closer attested through seq 1; this replica had already applied seq 2.
    log.files.set('old-00000099', [first, v1('old-00000099', 2, 't-00000b02')]);
    ada.ledger.setCursor('old-00000099', 2);
    ada.roster.closeLegacy([
      { replica: 'old-00000099', throughSeq: 1, digest: digestV1([first]) },
    ]);
    legacy.onClosed();
    expect(
      ada.fed
        .problems()
        .some(
          (p) =>
            p.subject === 'team:race:old-00000099' &&
            p.message.includes('t-00000b02')
        )
    ).toBe(true);
  });
});
