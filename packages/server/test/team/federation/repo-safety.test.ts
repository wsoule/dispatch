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
});
