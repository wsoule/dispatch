import {
  buildOp,
  generateReplicaKeys,
  ZERO_HASH,
} from '@dispatch/protocol/federation';
import type { FederatedOp } from '@dispatch/protocol/federation';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultAsyncGitRunner } from '../../../src/sync/worktree.js';
import type { BoardOp } from '../../../src/team/boardSync/engine.js';
import { SyncRepo } from '../../../src/team/boardSync/repo.js';
import { runGitSync } from '../../orchestrator/helpers.js';

// FW-R22(1): the sync branch is hostile input for the filesystem too. A path
// under fed/ or ops/ that is a symlink or not a regular file is never read
// through, and this replica's own paths are rewritten as regular files.

const A = 'ada-0000000a';
const B = 'bob-0000000b';
const keys = generateReplicaKeys();
let dir: string;
let remote: string;
let outside: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'fed-safe-')));
  remote = join(dir, 'remote.git');
  outside = join(dir, 'user-file.txt');
  writeFileSync(outside, 'precious\n');
  runGitSync(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const clone = async (replica = A) => {
  const repo = new SyncRepo(
    join(dir, 'clone'),
    remote,
    'dispatch-sync',
    replica,
    defaultAsyncGitRunner
  );
  await repo.ensure();
  return repo;
};
const keyOp = (replica: string): FederatedOp =>
  buildOp(
    {
      replica,
      seq: 1,
      prev: ZERO_HASH,
      hlc: `0000000001000.0000.${replica}`,
      type: 'key',
      body: { handle: 'x' },
    },
    keys.signPriv
  );
const acks = (replica: string) => ({
  v: 1 as const,
  replica,
  through: { [B]: 1 },
  at: '2026-10-01T00:00:00.000Z',
  sig: 'sig',
});
const isLink = (path: string) => lstatSync(path).isSymbolicLink();

describe('a hostile sync branch and the filesystem', () => {
  it('runs the clone with core.symlinks off', async () => {
    await clone();
    expect(
      runGitSync(join(dir, 'clone'), ['config', 'core.symlinks']).trim()
    ).toBe('false');
  });

  it('never writes through a symlinked acks.json of its own', async () => {
    const repo = await clone();
    mkdirSync(join(dir, 'clone', 'fed', A), { recursive: true });
    symlinkSync(outside, join(dir, 'clone', 'fed', A, 'acks.json'));
    await repo.writeAcks(acks(A));
    expect(readFileSync(outside, 'utf8')).toBe('precious\n');
    expect(isLink(join(dir, 'clone', 'fed', A, 'acks.json'))).toBe(false);
    expect(repo.readAcks().get(A)?.through).toEqual({ [B]: 1 });
  });

  it("never reads another replica's symlinked acks.json", async () => {
    const repo = await clone();
    mkdirSync(join(dir, 'clone', 'fed', B), { recursive: true });
    writeFileSync(outside, JSON.stringify(acks(B)));
    symlinkSync(outside, join(dir, 'clone', 'fed', B, 'acks.json'));
    expect(repo.readAcks().has(B)).toBe(false);
  });

  it('never writes through a symlinked segment or log directory of its own', async () => {
    const repo = await clone();
    const outDir = join(dir, 'elsewhere');
    mkdirSync(outDir);
    mkdirSync(join(dir, 'clone', 'fed'), { recursive: true });
    symlinkSync(outDir, join(dir, 'clone', 'fed', A));
    await repo.writeV2([keyOp(A)]);
    expect(isLink(join(dir, 'clone', 'fed', A))).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe('precious\n');
    expect(repo.readV2(new Map()).map((e) => e.seq)).toEqual([1]);
    const segment = join(dir, 'clone', 'fed', A, '000000000001.jsonl');
    rmSync(segment);
    symlinkSync(outside, segment);
    await repo.writeV2([keyOp(A)]);
    expect(readFileSync(outside, 'utf8')).toBe('precious\n');
    expect(isLink(segment)).toBe(false);
  });

  it("never reads another replica's segment linked to /dev/zero or a file", async () => {
    const repo = await clone();
    mkdirSync(join(dir, 'clone', 'fed', B), { recursive: true });
    symlinkSync(
      '/dev/zero',
      join(dir, 'clone', 'fed', B, '000000000001.jsonl')
    );
    writeFileSync(outside, `${JSON.stringify(keyOp(B))}\n`);
    symlinkSync(outside, join(dir, 'clone', 'fed', B, '000000000002.jsonl'));
    expect(repo.readV2(new Map())).toEqual([]);
  });

  // M-a: an acks.json has no regular-file check before its read, so the open
  // itself must not block on a FIFO (O_NONBLOCK, then the fd's type).
  it('never blocks on a FIFO named acks.json', async () => {
    const repo = await clone();
    mkdirSync(join(dir, 'clone', 'fed', B), { recursive: true });
    Bun.spawnSync(['mkfifo', join(dir, 'clone', 'fed', B, 'acks.json')]);
    expect(repo.readAcks().has(B)).toBe(false);
  });

  it('never writes its v1 log through a symlink, nor reads another one', async () => {
    const repo = await clone();
    symlinkSync(outside, join(dir, 'clone', 'ops', `${A}.jsonl`));
    const op: BoardOp = {
      v: 1,
      replica: A,
      seq: 1,
      hlc: `0000000001000.0000.${A}`,
      task: 't-00000a01',
      kind: 'put',
    };
    await repo.write([op]);
    expect(readFileSync(outside, 'utf8')).toBe('precious\n');
    expect(repo.readV1(A).map((o) => o.seq)).toEqual([1]);
    writeFileSync(outside, `${JSON.stringify({ ...op, replica: B })}\n`);
    symlinkSync(outside, join(dir, 'clone', 'ops', `${B}.jsonl`));
    expect(repo.readV1(B)).toEqual([]);
    expect(repo.people().has('bob')).toBe(false);
  });

  // N2: a symlink a branch writer commits keeps mode 120000 in git, so a
  // fresh clone would check it out as a link and read nothing of its owner.
  it('checks a committed symlink out as a plain file in a fresh clone', async () => {
    const raw = join(dir, 'raw');
    runGitSync(dir, ['clone', '-q', remote, raw]);
    runGitSync(raw, ['checkout', '-q', '-b', 'dispatch-sync']);
    mkdirSync(join(raw, 'fed', B), { recursive: true });
    symlinkSync(outside, join(raw, 'fed', B, 'acks.json'));
    gitCommitAndPush(raw);
    await clone();
    expect(isLink(join(dir, 'clone', 'fed', B, 'acks.json'))).toBe(false);
  });

  it('re-records its own path a branch writer committed as a symlink', async () => {
    const repo = await clone();
    await repo.writeV2([keyOp(A)]);
    await repo.writeAcks(acks(A));
    await repo.exchange();
    const raw = join(dir, 'raw');
    runGitSync(dir, ['clone', '-q', '-b', 'dispatch-sync', remote, raw]);
    for (const name of ['acks.json', '000000000001.jsonl']) {
      rmSync(join(raw, 'fed', A, name));
      symlinkSync(outside, join(raw, 'fed', A, name));
    }
    gitCommitAndPush(raw);
    await repo.exchange();
    expect(await repo.repairOwn()).toBe(2);
    await repo.writeV2([keyOp(A)]);
    await repo.writeAcks(acks(A));
    await repo.exchange();
    const mode = (name: string) =>
      runGitSync(join(dir, 'clone'), [
        'ls-files',
        '-s',
        `fed/${A}/${name}`,
      ]).slice(0, 6);
    expect(mode('acks.json')).toBe('100644');
    expect(mode('000000000001.jsonl')).toBe('100644');
    const fresh = new SyncRepo(
      join(dir, 'fresh'),
      remote,
      'dispatch-sync',
      B,
      defaultAsyncGitRunner
    );
    await fresh.ensure();
    expect(fresh.readAcks().has(A)).toBe(true);
    expect(fresh.readV2(new Map()).map((e) => e.seq)).toEqual([1]);
  });

  // M-a: a FIFO never blocks a read; the fd itself is checked.
  it('never blocks on a FIFO named as a segment', async () => {
    const repo = await clone();
    mkdirSync(join(dir, 'clone', 'fed', B), { recursive: true });
    Bun.spawnSync([
      'mkfifo',
      join(dir, 'clone', 'fed', B, '000000000001.jsonl'),
    ]);
    expect(repo.readV2(new Map())).toEqual([]);
  });

  // M4: reads are size-capped.
  it('never reads an acks.json over its size cap', async () => {
    const repo = await clone();
    mkdirSync(join(dir, 'clone', 'fed', B), { recursive: true });
    writeFileSync(
      join(dir, 'clone', 'fed', B, 'acks.json'),
      JSON.stringify({ ...acks(B), pad: 'p'.repeat(2 * 1024 * 1024) })
    );
    expect(repo.readAcks().has(B)).toBe(false);
  });

  // B3: a flush that ran twice writes each v1 line once.
  it('writes each v1 seq into its log once', async () => {
    const repo = await clone();
    const op: BoardOp = {
      v: 1,
      replica: A,
      seq: 1,
      hlc: `0000000001000.0000.${A}`,
      task: 't-00000a01',
      kind: 'put',
    };
    await repo.write([op]);
    await repo.write([op, { ...op, seq: 2 }]);
    expect(repo.readV1(A).map((o) => o.seq)).toEqual([1, 2]);
  });

  // B3: a line someone else put at this machine's seq does not stand in for it.
  it('writes its own op even when the branch holds another line at that seq', async () => {
    const repo = await clone();
    const op: BoardOp = {
      v: 1,
      replica: A,
      seq: 1,
      hlc: `0000000001000.0000.${A}`,
      task: 't-00000a01',
      kind: 'put',
    };
    mkdirSync(join(dir, 'clone', 'ops'), { recursive: true });
    writeFileSync(
      join(dir, 'clone', 'ops', `${A}.jsonl`),
      `${JSON.stringify({ ...op, task: 't-0000bad1' })}\n`
    );
    await repo.write([op]);
    expect(repo.readV1(A).some((o) => o.task === 't-00000a01')).toBe(true);
  });
});

// Commits and pushes a raw clone's work, as any branch writer could.
function gitCommitAndPush(raw: string): void {
  runGitSync(raw, ['add', '-A']);
  runGitSync(raw, [
    '-c',
    'user.name=x',
    '-c',
    'user.email=x@example.com',
    'commit',
    '-q',
    '-m',
    'plant',
  ]);
  runGitSync(raw, ['push', '-q', 'origin', 'HEAD:dispatch-sync']);
}
