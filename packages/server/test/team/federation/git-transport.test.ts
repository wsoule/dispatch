import {
  buildOp,
  generateReplicaKeys,
  opHash,
  sealPayload,
  ZERO_HASH,
} from '@dispatch/protocol/federation';
import type { FederatedOp, LogEntry } from '@dispatch/protocol/federation';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultAsyncGitRunner } from '../../../src/sync/worktree.js';
import { SyncRepo } from '../../../src/team/boardSync/repo.js';
import {
  GitFederationTransport,
  signedEntry,
} from '../../../src/team/federation/git.js';
import { runGitSync } from '../../orchestrator/helpers.js';

const A = 'ada-0000000a';
const keys = generateReplicaKeys();
const peer = generateReplicaKeys();
let dir: string;
let remote: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'fed-git-')));
  remote = join(dir, 'remote.git');
  runGitSync(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const clone = (name: string, replica: string) =>
  new SyncRepo(
    join(dir, name),
    remote,
    'dispatch-sync',
    replica,
    defaultAsyncGitRunner
  );
const hlc = (ms: number) => `${String(ms).padStart(13, '0')}.0000.${A}`;

function chain(n: number): FederatedOp[] {
  const ops: FederatedOp[] = [
    buildOp(
      {
        replica: A,
        seq: 1,
        prev: ZERO_HASH,
        hlc: hlc(1000),
        type: 'key',
        body: { handle: 'ada' },
      },
      keys.signPriv
    ),
  ];
  for (let seq = 2; seq <= n; seq++) {
    const prev = opHash(ops[ops.length - 1]);
    if (seq % 2 === 0) {
      const { to, sealed } = sealPayload({
        replica: A,
        seq,
        type: 'mail',
        payload: { n: seq },
        recipients: new Map([['bob-0000000b', peer.sealPub]]),
      });
      ops.push(
        buildOp(
          {
            replica: A,
            seq,
            prev,
            hlc: hlc(1000 + seq),
            type: 'mail',
            to,
            sealed,
          },
          keys.signPriv
        )
      );
    } else {
      ops.push(
        buildOp(
          {
            replica: A,
            seq,
            prev,
            hlc: hlc(1000 + seq),
            type: 'task',
            body: { task: 't-00000a01', kind: 'put', fields: { n: seq } },
          },
          keys.signPriv
        )
      );
    }
  }
  return ops;
}

describe('the fed/ tree', () => {
  it('rolls segments over and reads from the segment holding cursor + 1', async () => {
    const a = clone('a', A);
    await a.ensure();
    const ops = chain(7);
    await a.writeV2(ops, { ops: 3, bytes: 1024 * 1024 });
    const segments = readdirSync(join(dir, 'a', 'fed', A))
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
    expect(segments).toEqual([
      '000000000001.jsonl',
      '000000000004.jsonl',
      '000000000007.jsonl',
    ]);
    // Damage the first segment: a reader past it never opens it.
    writeFileSync(join(dir, 'a', 'fed', A, '000000000001.jsonl'), 'garbage\n');
    expect(a.readV2(new Map([[A, 4]])).map((e) => e.seq)).toEqual([5, 6, 7]);
  });

  it('skips a torn last line until its writer finishes it', async () => {
    const a = clone('a', A);
    await a.ensure();
    await a.writeV2(chain(2));
    appendFileSync(
      join(dir, 'a', 'fed', A, '000000000001.jsonl'),
      '{"v":2,"replica"'
    );
    expect(a.readV2(new Map()).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('is invisible to a v1 reader', async () => {
    const a = clone('a', A);
    await a.ensure();
    await a.writeV2(chain(3));
    expect(a.people().size).toBe(0);
    expect(a.readOthers(() => 0)).toEqual([]);
  });

  it('prunes acknowledged sealed ops to their signed stubs and keeps board ops', async () => {
    const a = clone('a', A);
    await a.ensure();
    const ops = chain(4);
    await a.writeV2(ops);
    expect(await a.pruneOwn((op) => op.type === 'mail')).toEqual([2, 4]);
    const read = a.readV2(new Map());
    expect(read.map((e) => ('pruned' in e ? 'stub' : e.type))).toEqual([
      'key',
      'stub',
      'task',
      'stub',
    ]);
    expect(read.map((e) => opHash(e))).toEqual(ops.map((o) => opHash(o)));
  });
});

describe('segment names are hints (FW-R22 I1)', () => {
  it('ignores a segment whose first line is not its op at the named seq, and never appends into it', async () => {
    const a = clone('a', A);
    await a.ensure();
    const ops = chain(6);
    await a.writeV2(ops.slice(0, 5));
    // An empty file named for seq 3 would make a reader at seq 2 skip segment 1.
    writeFileSync(join(dir, 'a', 'fed', A, '000000000003.jsonl'), '');
    expect(a.readV2(new Map([[A, 2]])).map((e) => e.seq)).toEqual([3, 4, 5]);
    await a.writeV2(ops.slice(5));
    expect(
      readFileSync(join(dir, 'a', 'fed', A, '000000000003.jsonl'), 'utf8')
    ).toBe('');
    expect(a.readV2(new Map([[A, 2]])).map((e) => e.seq)).toEqual([3, 4, 5, 6]);
  });

  // N1: a copy of a real op is a valid first line, so the name check alone
  // passes it; segments must also be non-overlapping seq ranges.
  it('ignores a segment that copies an op an earlier segment holds, and appends only after its own head', async () => {
    const a = clone('a', A);
    await a.ensure();
    const ops = chain(8);
    await a.writeV2(ops.slice(0, 5));
    const copy = join(dir, 'a', 'fed', A, '000000000003.jsonl');
    writeFileSync(copy, `${JSON.stringify(ops[2])}\n`);
    expect(a.readV2(new Map([[A, 3]])).map((e) => e.seq)).toEqual([4, 5]);
    await a.writeV2(ops.slice(5));
    expect(readFileSync(copy, 'utf8')).toBe(`${JSON.stringify(ops[2])}\n`);
    expect(a.readV2(new Map([[A, 3]])).map((e) => e.seq)).toEqual([
      4, 5, 6, 7, 8,
    ]);
  });

  it('never rewrites a torn segment: it writes the next op to a fresh file (M3, FW-R23)', async () => {
    const a = clone('a', A);
    await a.ensure();
    const ops = chain(3);
    await a.writeV2(ops.slice(0, 2));
    const seg = join(dir, 'a', 'fed', A, '000000000001.jsonl');
    appendFileSync(seg, '{"v":2,"repl');
    const torn = readFileSync(seg, 'utf8');
    await a.writeV2(ops.slice(2));
    expect(readFileSync(seg, 'utf8')).toBe(torn);
    expect(a.readV2(new Map()).map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

describe('segments hold storage, never order (FW-R23)', () => {
  const twoSegments = async () => {
    const a = clone('a', A);
    await a.ensure();
    const ops = chain(10);
    await a.writeV2(ops.slice(0, 5), { ops: 5, bytes: 1024 * 1024 });
    await a.writeV2(ops.slice(5), { ops: 5, bytes: 1024 * 1024 });
    const seg = (n: string) => join(dir, 'a', 'fed', A, `${n}.jsonl`);
    return { a, ops, seg1: seg('000000000001'), seg6: seg('000000000006') };
  };
  const seqs = (entries: { seq: number }[]) =>
    [...new Set(entries.map((e) => e.seq))].sort((x, y) => x - y);

  it('reads past a byte-identical copy of a later op, and a republish destroys no real file', async () => {
    const { a, ops, seg1, seg6 } = await twoSegments();
    appendFileSync(seg1, `${JSON.stringify(ops[9])}\n`);
    expect(seqs(a.readV2(new Map([[A, 5]])))).toEqual([6, 7, 8, 9, 10]);
    const before = readFileSync(seg6, 'utf8');
    const ta = new GitFederationTransport({
      repo: a,
      replica: A,
      signPriv: keys.signPriv,
      verifyAcks: () => true,
      acknowledgedBy: () => false,
      ownLog: () => ops,
      now: () => new Date(),
    });
    await ta.publish([]);
    expect(readFileSync(seg6, 'utf8')).toBe(before);
    expect(seqs(a.readV2(new Map()))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('reads past a junk line with a high seq, and appends only where the last line is its head', async () => {
    const { a, ops, seg1, seg6 } = await twoSegments();
    const junk = { ...ops[4], seq: 999, sig: 'junk' };
    appendFileSync(seg1, `${JSON.stringify(junk)}\n`);
    const junked = readFileSync(seg1, 'utf8');
    expect(seqs(a.readV2(new Map([[A, 5]])))).toEqual([6, 7, 8, 9, 10, 999]);
    const next = buildOp(
      {
        replica: A,
        seq: 11,
        prev: opHash(ops[9]),
        hlc: hlc(1011),
        type: 'task',
        body: { task: 't-00000a01', kind: 'put', fields: { n: 11 } },
      },
      keys.signPriv
    );
    await a.writeV2([next]);
    expect(readFileSync(seg1, 'utf8')).toBe(junked);
    expect(readFileSync(seg6, 'utf8').trim().split('\n')).toHaveLength(6);
  });
});

describe('the read budget (FW-R23 hint)', () => {
  const seqs = (entries: { seq: number }[]) =>
    [...new Set(entries.map((e) => e.seq))].sort((x, y) => x - y);

  it('reads from the segment named for cursor + 1 first, within a per-pass budget, and the rest on later passes', async () => {
    const a = clone('a', A);
    await a.ensure();
    await a.writeV2(chain(9), { ops: 3, bytes: 1024 * 1024 });
    const budget =
      Buffer.byteLength(
        readFileSync(join(dir, 'a', 'fed', A, '000000000004.jsonl'), 'utf8')
      ) + 1;
    // One segment's budget reads one new segment per pass.
    expect(seqs(a.readV2(new Map([[A, 4]]), { budget }))).toEqual([5, 6]);
    expect(seqs(a.readV2(new Map([[A, 4]]), { budget }))).toEqual([
      5, 6, 7, 8, 9,
    ]);
    // A reader from the start, with nothing cached, works forward the same way.
    const fresh = clone('a', A);
    expect(seqs(fresh.readV2(new Map(), { budget }))).toEqual([1, 2, 3]);
    expect(seqs(fresh.readV2(new Map(), { budget }))).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it('holds no more than the budget in cache, and drops lines the cursor has passed', async () => {
    const a = clone('a', A);
    await a.ensure();
    await a.writeV2(chain(9), { ops: 3, bytes: 1024 * 1024 });
    const segment = readFileSync(
      join(dir, 'a', 'fed', A, '000000000004.jsonl'),
      'utf8'
    );
    const budget = Buffer.byteLength(segment) + 1;
    a.readV2(new Map([[A, 3]]), { budget });
    a.readV2(new Map([[A, 3]]), { budget });
    a.readV2(new Map([[A, 3]]), { budget });
    expect(a.cachedBytes()).toBeLessThanOrEqual(budget);
    expect(a.cachedBytes()).toBeGreaterThan(0);
    a.readV2(new Map([[A, 9]]), { budget });
    expect(a.cachedBytes()).toBe(0);
  });

  // I2: junk files named past the cursor, rewritten every pass, must not
  // starve the segment the owner appends to.
  it('advances past junk files rewritten each pass while the owner appends, and names the starvation', async () => {
    const a = clone('a', A);
    await a.ensure();
    const ops = chain(16);
    await a.writeV2(ops.slice(0, 10));
    const signedBy = (e: LogEntry) => signedEntry(e, keys.signPub);
    const segDir = join(dir, 'a', 'fed', A);
    const budget = 4096;
    let cursor = 10;
    let headHash = opHash(ops[9]);
    const read = () =>
      a.readV2(new Map([[A, cursor]]), {
        budget,
        heads: new Map([[A, headHash]]),
        signedBy,
      });
    read();
    for (let k = 0; k < 6; k++) {
      for (const n of [11, 12, 13, 14])
        writeFileSync(
          join(segDir, `0000000000${n}.jsonl`),
          `${'x'.repeat(budget)}${k}\n`
        );
      await a.writeV2([ops[10 + k]]);
      const next = read().find(
        (e) => e.seq === cursor + 1 && e.prev === headHash
      );
      if (next !== undefined) {
        cursor = next.seq;
        headHash = opHash(next);
      }
    }
    expect(cursor).toBe(16);
    expect(a.starvedReplicas()).toEqual([A]);
  });

  // FW-R25 (the final review's R4): junk directories under many ids cost a
  // pass no more than its global budget; known replicas are read first, and an
  // unknown id only as far as its key op.
  it('bounds a pass across replica directories, known ones first', async () => {
    const a = clone('a', A);
    await a.ensure();
    await a.writeV2(chain(3));
    const junk = `${'x'.repeat(1000)}\n`.repeat(1000);
    for (let n = 0; n < 40; n++) {
      const id = `mal-${String(n).padStart(8, '0')}`;
      mkdirSync(join(dir, 'a', 'fed', id), { recursive: true });
      writeFileSync(join(dir, 'a', 'fed', id, '000000000001.jsonl'), junk);
    }
    const stranger = 'eve-0000000e';
    const k = generateReplicaKeys();
    const keyOp = buildOp(
      {
        replica: stranger,
        seq: 1,
        prev: ZERO_HASH,
        hlc: `0000000002000.0000.${stranger}`,
        type: 'key',
        body: {
          handle: 'eve',
          device: 'x',
          build: '0',
          signPub: k.signPub,
          sealPub: k.sealPub,
          legacy: null,
        },
      },
      k.signPriv
    );
    const second = buildOp(
      {
        replica: stranger,
        seq: 2,
        prev: opHash(keyOp),
        hlc: `0000000002001.0000.${stranger}`,
        type: 'task',
        body: { task: 't-00000a01', kind: 'put', fields: {} },
      },
      k.signPriv
    );
    mkdirSync(join(dir, 'a', 'fed', stranger), { recursive: true });
    writeFileSync(
      join(dir, 'a', 'fed', stranger, '000000000001.jsonl'),
      `${JSON.stringify(keyOp)}\n${JSON.stringify(second)}\n`
    );
    const total = 2 * 1024 * 1024;
    const read = a.readV2(new Map(), {
      known: new Set([A]),
      totalBudget: total,
      maxUnknown: 50,
    });
    expect(a.lastPassBytes()).toBeLessThanOrEqual(total);
    expect(seqs(read.filter((e) => e.replica === A))).toEqual([1, 2, 3]);
    expect(
      read.filter((e) => e.replica === stranger).map((e) => e.seq)
    ).toEqual([1]);
    expect(read.some((e) => e.replica.startsWith('mal-'))).toBe(false);
  });

  // FW-R26(4), the re-verify's R8: hundreds of claim-only ids never starve a
  // member; they are probed a few a pass, the starting point rotating.
  it('reads members first and probes claim-only ids a few a pass, rotating', async () => {
    const a = clone('a', A);
    await a.ensure();
    await a.writeV2(chain(3));
    const junk: string[] = [];
    for (let n = 0; n < 700; n++) {
      const id = `aaa-${String(n).padStart(8, '0')}`;
      junk.push(id);
      const k = generateReplicaKeys();
      const keyOp = buildOp(
        {
          replica: id,
          seq: 1,
          prev: ZERO_HASH,
          hlc: `0000000002000.0000.${id}`,
          type: 'key',
          body: {
            handle: 'x',
            device: 'x',
            build: '0',
            signPub: k.signPub,
            sealPub: k.sealPub,
            legacy: null,
          },
        },
        k.signPriv
      );
      mkdirSync(join(dir, 'a', 'fed', id), { recursive: true });
      writeFileSync(
        join(dir, 'a', 'fed', id, '000000000001.jsonl'),
        `${JSON.stringify(keyOp)}\n${'x'.repeat(2000)}\n`
      );
    }
    const claimOnly = new Set(junk);
    const tier = (r: string) => (r === A ? 0 : claimOnly.has(r) ? 2 : 1);
    const probed = new Set<string>();
    for (let pass = 0; pass < 3; pass++) {
      const read = a.readV2(new Map(), {
        tier,
        maxUnknown: 8,
        totalBudget: 1024 * 1024,
      });
      expect(seqs(read.filter((e) => e.replica === A))).toEqual([1, 2, 3]);
      const these = new Set(
        read.filter((e) => e.replica !== A).map((e) => e.replica)
      );
      expect(these.size).toBeLessThanOrEqual(8);
      for (const r of these) probed.add(r);
    }
    expect(probed.size).toBe(24);
  });

  // FW-R25: the default pass budget holds across replicas.
  it('reads at most 32 MiB in one pass by default', async () => {
    const a = clone('a', A);
    await a.ensure();
    const big = `${'x'.repeat(1023)}\n`.repeat(4 * 1024 - 8);
    for (let n = 0; n < 10; n++) {
      const id = `big-${String(n).padStart(8, '0')}`;
      mkdirSync(join(dir, 'a', 'fed', id), { recursive: true });
      writeFileSync(join(dir, 'a', 'fed', id, '000000000001.jsonl'), big);
    }
    a.readV2(new Map());
    expect(a.lastPassBytes()).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(a.lastPassBytes()).toBeGreaterThan(24 * 1024 * 1024);
  });

  // FW-R28: a probe finds a key op anywhere in a file's head, in any file,
  // so neither a junk first line nor junk files named first hide it.
  it('finds an unknown id’s key op behind a junk line and behind 16 junk files', async () => {
    const a = clone('a', A);
    await a.ensure();
    const keyOpFor = (id: string) => {
      const k = generateReplicaKeys();
      return buildOp(
        {
          replica: id,
          seq: 1,
          prev: ZERO_HASH,
          hlc: `0000000002000.0000.${id}`,
          type: 'key',
          body: {
            handle: 'x',
            device: 'x',
            build: '0',
            signPub: k.signPub,
            sealPub: k.sealPub,
            legacy: null,
          },
        },
        k.signPriv
      );
    };
    const lined = 'bob-0000000b';
    mkdirSync(join(dir, 'a', 'fed', lined), { recursive: true });
    writeFileSync(
      join(dir, 'a', 'fed', lined, '000000000001.jsonl'),
      `{"junk":true}\n${JSON.stringify(keyOpFor(lined))}\n`
    );
    const filed = 'cy-0000000c';
    mkdirSync(join(dir, 'a', 'fed', filed), { recursive: true });
    for (let n = 1; n <= 16; n++)
      writeFileSync(
        join(dir, 'a', 'fed', filed, `${String(n).padStart(12, '0')}.jsonl`),
        '{"junk":true}\n'
      );
    writeFileSync(
      join(dir, 'a', 'fed', filed, '000000000017.jsonl'),
      `${JSON.stringify(keyOpFor(filed))}\n`
    );
    const read = a.readV2(new Map(), { tier: () => 2, maxUnknown: 8 });
    const keyed = new Set(
      read.filter((e) => e.type === 'key').map((e) => e.replica)
    );
    expect([...keyed].sort()).toEqual([lined, filed]);
  });

  it('sees an append to a segment it already read', async () => {
    const a = clone('a', A);
    await a.ensure();
    const ops = chain(4);
    await a.writeV2(ops.slice(0, 3));
    expect(seqs(a.readV2(new Map()))).toEqual([1, 2, 3]);
    await a.writeV2(ops.slice(3));
    expect(seqs(a.readV2(new Map()))).toEqual([1, 2, 3, 4]);
  });
});

describe('the writer and the republish, against what the branch holds', () => {
  const transport = (a: SyncRepo, own: () => FederatedOp[]) =>
    new GitFederationTransport({
      repo: a,
      replica: A,
      signPriv: keys.signPriv,
      verifyAcks: () => true,
      acknowledgedBy: () => false,
      ownLog: own,
      now: () => new Date(),
    });

  it('never appends to a clean file that sorts first but does not end on its head', async () => {
    const a = clone('a', A);
    await a.ensure();
    const ops = chain(5);
    await a.writeV2(ops.slice(0, 4));
    const decoy = join(dir, 'a', 'fed', A, '000000000000.jsonl');
    writeFileSync(decoy, `${JSON.stringify(ops[2])}\n`);
    await a.writeV2(ops.slice(4));
    expect(readFileSync(decoy, 'utf8')).toBe(`${JSON.stringify(ops[2])}\n`);
    const seg = readFileSync(
      join(dir, 'a', 'fed', A, '000000000001.jsonl'),
      'utf8'
    );
    expect(seg.trim().split('\n')).toHaveLength(5);
  });

  it('writes a fresh segment under the first name no file uses', async () => {
    const a = clone('a', A);
    await a.ensure();
    const ops = chain(5);
    await a.writeV2(ops.slice(0, 4), { ops: 4, bytes: 1024 * 1024 });
    const seg = (n: string) => join(dir, 'a', 'fed', A, `${n}.jsonl`);
    writeFileSync(seg('000000000005'), 'junk\n');
    writeFileSync(seg('000000000006'), 'junk\n');
    await a.writeV2([ops[4]], { ops: 4, bytes: 1024 * 1024 });
    expect(readFileSync(seg('000000000005'), 'utf8')).toBe('junk\n');
    expect(readFileSync(seg('000000000006'), 'utf8')).toBe('junk\n');
    expect(JSON.parse(readFileSync(seg('000000000007'), 'utf8')).seq).toBe(5);
  });

  it('reads only its own segments, and only its own lines in them (M-g)', async () => {
    const a = clone('a', A);
    await a.ensure();
    const ops = chain(2);
    await a.writeV2([ops[0]]);
    const other = 'bob-0000000b';
    mkdirSync(join(dir, 'a', 'fed', other), { recursive: true });
    writeFileSync(
      join(dir, 'a', 'fed', other, '000000000002.jsonl'),
      `${JSON.stringify(ops[1])}\n`
    );
    writeFileSync(
      join(dir, 'a', 'fed', A, '000000000009.jsonl'),
      `${JSON.stringify({ ...ops[1], replica: other })}\n`
    );
    expect(a.readOwn().map((e) => e.seq)).toEqual([1]);
  });

  it('republishes an op its own files hold only as junk at that seq (by hash, M-g)', async () => {
    const a = clone('a', A);
    await a.ensure();
    const ops = chain(3);
    await a.writeV2([ops[0]]);
    writeFileSync(
      join(dir, 'a', 'fed', A, '000000000050.jsonl'),
      `${JSON.stringify({ ...ops[1], sig: 'junk' })}\n`
    );
    await transport(a, () => ops.slice(0, 2)).publish([ops[2]]);
    expect(
      a
        .readOwn()
        .filter((e) => e.sig !== 'junk')
        .map((e) => e.seq)
        .sort((x, y) => x - y)
    ).toEqual([1, 2, 3]);
  });

  it('republishes an op only another replica’s files hold (its own files only, M-g)', async () => {
    const a = clone('a', A);
    await a.ensure();
    const ops = chain(2);
    await a.writeV2([ops[0]]);
    mkdirSync(join(dir, 'a', 'fed', 'bob-0000000b'), { recursive: true });
    writeFileSync(
      join(dir, 'a', 'fed', 'bob-0000000b', '000000000002.jsonl'),
      `${JSON.stringify(ops[1])}\n`
    );
    await transport(a, () => ops).publish([]);
    const own = readdirSync(join(dir, 'a', 'fed', A))
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) =>
        readFileSync(join(dir, 'a', 'fed', A, f), 'utf8')
          .trim()
          .split('\n')
      )
      .map((line) => (JSON.parse(line) as { seq: number }).seq);
    expect(own.sort((x, y) => x - y)).toEqual([1, 2]);
  });
});

describe('the git environment (FW-R25, FW-R26(5))', () => {
  const originalHome = process.env.HOME;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
  });
  // A HOME whose .gitconfig includes another file.
  const fakeHome = (config: string, extra: string): void => {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, '.gitconfig'), config);
    writeFileSync(join(home, 'extra.gitconfig'), extra);
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, '.config');
  };

  it('fetches and pushes through the person’s insteadOf alias and include', async () => {
    fakeHome(
      `[include]\n\tpath = ${join(dir, 'home', 'extra.gitconfig')}\n[credential "https://example.com"]\n\thelper = !echo scoped\n`,
      `[url "${remote}"]\n\tinsteadOf = team-board:\n`
    );
    const viaAlias = new SyncRepo(
      join(dir, 'aliased'),
      'team-board:',
      'dispatch-sync',
      A,
      defaultAsyncGitRunner
    );
    await viaAlias.ensure();
    await viaAlias.writeV2(chain(2));
    expect((await viaAlias.exchange()).offline).toBeUndefined();
    const b = clone('b', 'bob-0000000b');
    await b.ensure();
    expect(b.readV2(new Map()).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('commits in the clone with none of the person’s global config', async () => {
    fakeHome('[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n', '');
    const a = clone('a', A);
    await a.ensure();
    await a.writeV2(chain(2));
    expect((await a.exchange()).offline).toBeUndefined();
    const b = clone('b', 'bob-0000000b');
    await b.ensure();
    expect(b.readV2(new Map()).map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe('GitFederationTransport', () => {
  it('publishes into one clone and pulls into another through the remote', async () => {
    const a = clone('a', A);
    const b = clone('b', 'bob-0000000b');
    const now = () => new Date('2026-09-26T10:00:00.000Z');
    const make = (repo: SyncRepo, replica: string) =>
      new GitFederationTransport({
        repo,
        replica,
        signPriv: keys.signPriv,
        verifyAcks: () => true,
        acknowledgedBy: () => false,
        ownLog: () => [],
        now,
      });
    const ta = make(a, A);
    const tb = make(b, 'bob-0000000b');
    await a.ensure();
    await b.ensure();
    await ta.publish(chain(3));
    await ta.pull(new Map());
    expect((await tb.pull(new Map())).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(tb.health().lastError).toBeNull();
    await tb.ack(new Map([[A, 3]]));
    await tb.pull(new Map());
    await ta.pull(new Map());
    await ta.ack(new Map());
    expect(ta.health().acks['bob-0000000b']).toBe('2026-09-26T10:00:00.000Z');
  });

  // FW-R25 (the final review's R2): a line someone appended to this
  // replica's segment makes its next merge conflict. The clone resets to the
  // remote tree, writes back what its own log holds, and says so.
  it('recovers from a merge conflict on its own segment and publishes again', async () => {
    const a = clone('a', A);
    const b = clone('b', 'bob-0000000b');
    const ops = chain(4);
    let published: FederatedOp[] = [];
    const resets: string[] = [];
    const make = (repo: SyncRepo, replica: string, own: () => FederatedOp[]) =>
      new GitFederationTransport({
        repo,
        replica,
        signPriv: keys.signPriv,
        verifyAcks: () => true,
        acknowledgedBy: () => false,
        ownLog: own,
        onReset: (why) => resets.push(why),
        now: () => new Date(),
      });
    const ta = make(a, A, () => published);
    const tb = make(b, 'bob-0000000b', () => []);
    await a.ensure();
    await b.ensure();
    published = ops.slice(0, 2);
    await ta.publish(published);
    await ta.pull(new Map());
    await tb.pull(new Map());
    const seg = join(dir, 'b', 'fed', A, '000000000001.jsonl');
    appendFileSync(seg, '{"junk":1}\n');
    runGitSync(join(dir, 'b'), ['add', '-A']);
    runGitSync(join(dir, 'b'), [
      '-c',
      'user.name=x',
      '-c',
      'user.email=x@example.com',
      'commit',
      '-q',
      '-m',
      'junk',
    ]);
    runGitSync(join(dir, 'b'), ['push', '-q', 'origin', 'HEAD:dispatch-sync']);
    published = ops;
    await ta.publish(ops.slice(2));
    expect(ta.health().unpublished).toBe(2);
    await ta.pull(new Map());
    expect(ta.health().lastError).toBeNull();
    expect(ta.health().unpublished).toBe(0);
    expect(resets).toHaveLength(1);
    const seen = (await tb.pull(new Map()))
      .filter((e) => e.replica === A)
      .map((e) => e.seq);
    expect([...new Set(seen)].sort((x, y) => x - y)).toEqual([1, 2, 3, 4]);
  });

  // FW-R25: a commit the clone cannot make is named, and cleared once one is.
  it('reports a failed commit, and clears it on the next that lands', async () => {
    const a = clone('a', A);
    await a.ensure();
    const commits: (string | null)[] = [];
    const ta = new GitFederationTransport({
      repo: a,
      replica: A,
      signPriv: keys.signPriv,
      verifyAcks: () => true,
      acknowledgedBy: () => false,
      ownLog: () => [],
      onCommit: (failed) => commits.push(failed),
      now: () => new Date(),
    });
    const ops = chain(2);
    writeFileSync(join(dir, 'a', '.git', 'index.lock'), '');
    await expect(ta.publish(ops.slice(0, 1))).rejects.toThrow(
      'could not commit'
    );
    rmSync(join(dir, 'a', '.git', 'index.lock'));
    await ta.publish(ops.slice(1));
    expect(commits.map((c) => c === null)).toEqual([false, true]);
  });

  // FW-R22 M6: a merge that removes this replica's segments loses nothing;
  // its next publish writes back what its own log holds.
  it('re-publishes its own ops a merge removed from the branch', async () => {
    const a = clone('a', A);
    const b = clone('b', 'bob-0000000b');
    const ops = chain(4);
    const make = (repo: SyncRepo, replica: string, own: () => FederatedOp[]) =>
      new GitFederationTransport({
        repo,
        replica,
        signPriv: keys.signPriv,
        verifyAcks: () => true,
        acknowledgedBy: () => false,
        ownLog: own,
        now: () => new Date(),
      });
    let published: FederatedOp[] = [];
    const ta = make(a, A, () => published);
    const tb = make(b, 'bob-0000000b', () => []);
    await a.ensure();
    await b.ensure();
    published = ops.slice(0, 3);
    await ta.publish(published);
    await ta.pull(new Map());
    await tb.pull(new Map());
    runGitSync(join(dir, 'b'), ['rm', '-q', '-r', join('fed', A)]);
    runGitSync(join(dir, 'b'), [
      '-c',
      'user.name=x',
      '-c',
      'user.email=x@x',
      'commit',
      '-q',
      '-m',
      'drop',
    ]);
    await tb.pull(new Map());
    await ta.pull(new Map());
    expect(a.readV2(new Map())).toEqual([]);
    published = ops;
    await ta.publish(ops.slice(3));
    await ta.pull(new Map());
    expect((await tb.pull(new Map())).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  // N2: a branch writer turned this replica's segment into a symlink; the
  // next ack restores it from the local log, and a fresh clone reads it.
  it('restores its own files a branch writer turned into symlinks, on the next ack', async () => {
    const a = clone('a', A);
    const ops = chain(2);
    const ta = new GitFederationTransport({
      repo: a,
      replica: A,
      signPriv: keys.signPriv,
      verifyAcks: () => true,
      acknowledgedBy: () => false,
      ownLog: () => ops,
      now: () => new Date(),
    });
    await a.ensure();
    await ta.publish(ops);
    await ta.pull(new Map());
    const raw = join(dir, 'raw');
    runGitSync(dir, ['clone', '-q', '-b', 'dispatch-sync', remote, raw]);
    rmSync(join(raw, 'fed', A, '000000000001.jsonl'));
    symlinkSync('/etc/hosts', join(raw, 'fed', A, '000000000001.jsonl'));
    runGitSync(raw, ['add', '-A']);
    runGitSync(raw, [
      '-c',
      'user.name=x',
      '-c',
      'user.email=x@x',
      'commit',
      '-q',
      '-m',
      'plant',
    ]);
    runGitSync(raw, ['push', '-q', 'origin', 'HEAD:dispatch-sync']);
    await ta.pull(new Map());
    await ta.ack(new Map());
    await ta.pull(new Map());
    const fresh = clone('fresh', 'bob-0000000b');
    await fresh.ensure();
    expect(fresh.readV2(new Map()).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('reports an unreachable remote without losing what it was given', async () => {
    const a = clone('a', A);
    await a.ensure();
    const ta = new GitFederationTransport({
      repo: a,
      replica: A,
      signPriv: keys.signPriv,
      verifyAcks: () => true,
      acknowledgedBy: () => false,
      ownLog: () => [],
      now: () => new Date(),
    });
    rmSync(remote, { recursive: true, force: true });
    await ta.publish(chain(2));
    await expect(ta.pull(new Map())).rejects.toThrow();
    expect(ta.health().lastError).not.toBeNull();
    expect(a.readV2(new Map()).map((e) => e.seq)).toEqual([1, 2]);
  });
});
