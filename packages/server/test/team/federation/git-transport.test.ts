import {
  buildOp,
  generateReplicaKeys,
  opHash,
  sealPayload,
  ZERO_HASH,
} from '@dispatch/protocol/federation';
import type { FederatedOp } from '@dispatch/protocol/federation';
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
import { GitFederationTransport } from '../../../src/team/federation/git.js';
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
        .sort()
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
    expect(own.sort()).toEqual([1, 2]);
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
