import {
  MAX_OP_BYTES,
  opHash,
  REPLICA_ID,
  stubOf,
} from '@dispatch/protocol/federation';
import type { FederatedOp, LogEntry } from '@dispatch/protocol/federation';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { AsyncGitRunner } from '../../sync/worktree.js';
import type { Watermarks } from '../federation/transport.js';
import type { BoardOp } from './engine.js';
import {
  listDir,
  ownFile,
  readCapped,
  realDir,
  regularFile,
} from './safeFs.js';

// The git half of board sync: a clone of one branch, where every replica keeps
// an append-only log of the changes it made, `ops/<replica>.jsonl`.
//
// One file per replica, written only by that replica, is what makes this safe
// to run unattended. Two replicas never edit the same file, so pulling someone
// else's work into this clone is a merge git always completes on its own —
// there is no conflict for a person to resolve at 3am, and nothing here ever
// has to rewrite history or force a push.

const OPS_DIR = 'ops';
// Signed v2 ops: fed/<replica>/<first seq>.jsonl segments, and acks.json.
const FED_DIR = 'fed';
const ACKS = 'acks.json';
const SEGMENT_MAX_OPS = 1000;
const SEGMENT_MAX_BYTES = 4 * 1024 * 1024;
const SEGMENT = /^\d{12}\.jsonl$/;
// Reads are size-capped: a segment never grows past one op over its limit, an
// acks.json is one small map, and a v1 log is read whole.
const MAX_SEGMENT_READ = SEGMENT_MAX_BYTES + MAX_OP_BYTES;
const MAX_ACKS_READ = 1024 * 1024;
const MAX_V1_READ = 256 * 1024 * 1024;
const segmentName = (firstSeq: number): string =>
  `${String(firstSeq).padStart(12, '0')}.jsonl`;

/** A replica's signed statement of how far it has read everyone's log. */
export interface SignedAcks {
  v: 1;
  replica: string;
  through: Record<string, number>;
  at: string;
  sig: string;
}

// Identical on every replica, so two that each started the branch from
// nothing still merge cleanly: git treats the same file added on both sides
// with the same content as no conflict.
const README = `# Dispatch board sync

This branch carries changes to a Dispatch board between teammates' machines.
Each file under ops/ is one machine's append-only log; only that machine
writes it. Nothing here is meant to be edited by hand.
`;

// Commits here are the daemon's, not the person's, and must not run their
// hooks or ask for a signing key.
const IDENTITY = [
  '-c',
  'user.name=Dispatch sync',
  '-c',
  'user.email=sync@dispatch.invalid',
  '-c',
  'commit.gpgsign=false',
];

/** What a push-and-pull pass found. */
export interface RepoSyncResult {
  pushed: boolean;
  /** Why the remote could not be reached, when it could not. The replica
   *  keeps working locally and tries again next pass. */
  offline?: string;
}

export class SyncRepo {
  constructor(
    readonly dir: string,
    private readonly remoteUrl: string,
    private readonly branch: string,
    private readonly replica: string,
    private readonly git: AsyncGitRunner
  ) {}

  private async run(args: string[]): Promise<{ ok: boolean; out: string }> {
    const res = await this.git(this.dir, args);
    return { ok: res.status === 0, out: `${res.stdout}${res.stderr}`.trim() };
  }

  /**
   * Makes sure the clone exists and tracks the remote branch. A branch the
   * remote does not have yet is started locally and created by the first
   * push, so the first person to turn sync on needs nothing set up.
   */
  async ensure(): Promise<void> {
    if (!existsSync(join(this.dir, '.git'))) {
      mkdirSync(this.dir, { recursive: true });
      await this.run(['init', '-q']);
      // Before anything is checked out: a symlink on the branch arrives as a
      // plain file naming its target (FW-R22 N2).
      await this.run(['config', 'core.symlinks', 'false']);
      await this.run(['remote', 'add', 'origin', this.remoteUrl]);
      const fetched = await this.run(['fetch', '-q', 'origin', this.branch]);
      if (fetched.ok) {
        await this.run([
          'checkout',
          '-q',
          '-B',
          this.branch,
          `origin/${this.branch}`,
        ]);
      } else {
        await this.run(['checkout', '-q', '--orphan', this.branch]);
        writeFileSync(join(this.dir, 'README.md'), README);
        await this.run(['add', 'README.md']);
        await this.run([
          ...IDENTITY,
          'commit',
          '-q',
          '--no-verify',
          '-m',
          'Start board sync',
        ]);
      }
    } else {
      // The remote may have been changed in config.yml since the clone was
      // made; follow it rather than syncing with the old one forever.
      await this.run(['remote', 'set-url', 'origin', this.remoteUrl]);
    }
    // A symlink on the branch checks out as a plain file naming its target.
    await this.run(['config', 'core.symlinks', 'false']);
    if (!realDir(join(this.dir, OPS_DIR)))
      ownFile(this.dir, `${OPS_DIR}/.keep`);
  }

  /** Appends this replica's changes to its log and commits them. */
  async write(ops: BoardOp[]): Promise<void> {
    if (ops.length === 0) return;
    const file = ownFile(this.dir, `${OPS_DIR}/${this.replica}.jsonl`);
    appendFileSync(file, ops.map((op) => `${JSON.stringify(op)}\n`).join(''));
    await this.commitPaths(
      [join(OPS_DIR, `${this.replica}.jsonl`)],
      `${this.replica}: ${ops.length} change${ops.length === 1 ? '' : 's'}`
    );
  }

  private async commitPaths(paths: string[], message: string): Promise<void> {
    // git keeps a path's symlink mode when a plain file is added over it, so
    // an own path a branch writer committed as a link is recorded afresh.
    const links = await this.linkedPaths(paths);
    if (links.length > 0)
      await this.run(['rm', '--cached', '-q', '--', ...links]);
    await this.run(['add', ...paths]);
    const committed = await this.run([
      ...IDENTITY,
      'commit',
      '-q',
      '--no-verify',
      '-m',
      message,
    ]);
    // Nothing changed is not a failure: the branch already holds this.
    if (!committed.ok && !/nothing (added )?to commit/.test(committed.out))
      throw new Error(`could not commit sync log: ${committed.out}`);
  }

  // The tracked paths under `paths` that git holds as symlinks (mode 120000).
  private async linkedPaths(paths: string[]): Promise<string[]> {
    const listed = await this.run(['ls-files', '-s', '--', ...paths]);
    return listed.out
      .split('\n')
      .filter((line) => line.startsWith('120000 '))
      .map((line) => line.slice(line.indexOf('\t') + 1));
  }

  /** Removes this replica's own paths a branch writer committed as symlinks,
   *  committing once; the next publish and ack write them back (FW-R22 N2). */
  async repairOwn(): Promise<number> {
    const own = [
      join(FED_DIR, this.replica),
      join(OPS_DIR, `${this.replica}.jsonl`),
    ];
    const links = await this.linkedPaths(own);
    if (links.length === 0) return 0;
    await this.run(['rm', '--cached', '-q', '--', ...links]);
    for (const path of links) rmSync(join(this.dir, path), { force: true });
    const committed = await this.run([
      ...IDENTITY,
      'commit',
      '-q',
      '--no-verify',
      '-m',
      `${this.replica}: restore its own files`,
    ]);
    if (!committed.ok)
      throw new Error(`could not commit sync log: ${committed.out}`);
    return links.length;
  }

  /** Appends this replica's v2 ops to its current segment, rolling over at
   *  the limits, and commits; the next exchange pushes them. */
  async writeV2(
    entries: readonly LogEntry[],
    limits = { ops: SEGMENT_MAX_OPS, bytes: SEGMENT_MAX_BYTES }
  ): Promise<void> {
    if (entries.length === 0) return;
    const rel = (name: string) => `${FED_DIR}/${this.replica}/${name}`;
    const path = (name: string) => ownFile(this.dir, rel(name));
    // FW-R23: never truncate or overwrite a file. Append only to one that ends
    // cleanly on this replica's head (the first new op's prev); else write a
    // fresh file under the next unused name.
    const head = entries[0]?.prev;
    let current =
      this.segments(this.replica).find((name) => {
        const text = readCapped(path(name), MAX_SEGMENT_READ) ?? '';
        if (!text.endsWith('\n')) return false;
        const last = completeLines(path(name)).at(-1);
        const entry = last === undefined ? null : parseEntry(last);
        return entry !== null && opHash(entry) === head;
      }) ?? null;
    let count = current === null ? 0 : completeLines(path(current)).length;
    let size = current === null ? 0 : statSync(path(current)).size;
    for (const e of entries) {
      const line = `${JSON.stringify(e)}\n`;
      const bytes = Buffer.byteLength(line);
      if (
        current === null ||
        count >= limits.ops ||
        size + bytes > limits.bytes
      ) {
        current = this.unusedName(e.seq);
        count = 0;
        size = 0;
      }
      appendFileSync(path(current), line);
      count += 1;
      size += bytes;
    }
    await this.commitPaths(
      [join(FED_DIR, this.replica)],
      `${this.replica}: ${entries.length} signed op${entries.length === 1 ? '' : 's'}`
    );
  }

  /** Every replica's v2 entries past its watermark, from all of its segment
   *  files, identical lines once. Files are storage, never order (FW-R23): the
   *  pass rebuilds each log by its prev chain. Torn last lines are skipped. */
  readV2(since: Watermarks): LogEntry[] {
    const root = join(this.dir, FED_DIR);
    const out: LogEntry[] = [];
    for (const replica of listDir(root)) {
      if (!REPLICA_ID.test(replica) || !realDir(join(root, replica))) continue;
      const cursor = since.get(replica) ?? 0;
      const seen = new Set<string>();
      for (const name of this.segments(replica))
        for (const line of completeLines(join(root, replica, name))) {
          if (seen.has(line)) continue;
          seen.add(line);
          const entry = parseEntry(line);
          if (entry !== null && entry.replica === replica && entry.seq > cursor)
            out.push(entry);
        }
    }
    return out;
  }

  /** Writes this replica's acks.json and commits it, only when `through` changed. */
  async writeAcks(acks: SignedAcks): Promise<void> {
    const held = this.readAcks().get(this.replica);
    if (
      held !== undefined &&
      JSON.stringify(sortedKeys(held.through)) ===
        JSON.stringify(sortedKeys(acks.through))
    )
      return;
    const file = ownFile(this.dir, `${FED_DIR}/${this.replica}/${ACKS}`);
    writeFileSync(file, `${JSON.stringify(acks)}\n`);
    await this.commitPaths(
      [join(FED_DIR, this.replica, ACKS)],
      `${this.replica}: acks`
    );
  }

  /** Every replica's acks.json, by replica; malformed ones are skipped. */
  readAcks(): Map<string, SignedAcks> {
    const root = join(this.dir, FED_DIR);
    const out = new Map<string, SignedAcks>();
    for (const replica of listDir(root)) {
      if (!REPLICA_ID.test(replica) || !realDir(join(root, replica))) continue;
      const text = readCapped(join(root, replica, ACKS), MAX_ACKS_READ);
      if (text === null) continue;
      const acks = parseAcks(text);
      if (acks !== null && acks.replica === replica) out.set(replica, acks);
    }
    return out;
  }

  /** Replaces this replica's full mail and state ops that `prune` accepts
   *  with their signed stubs, committing once; the seqs it replaced. */
  async pruneOwn(prune: (op: FederatedOp) => boolean): Promise<number[]> {
    const pruned: number[] = [];
    for (const name of this.segments(this.replica)) {
      const file = ownFile(this.dir, `${FED_DIR}/${this.replica}/${name}`);
      let changed = false;
      const lines = completeLines(file).map((line) => {
        const entry = parseEntry(line);
        if (
          entry === null ||
          'pruned' in entry ||
          (entry.type !== 'mail' && entry.type !== 'state') ||
          !prune(entry)
        )
          return line;
        changed = true;
        pruned.push(entry.seq);
        return JSON.stringify(stubOf(entry));
      });
      if (changed) writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
    }
    if (pruned.length > 0)
      await this.commitPaths(
        [join(FED_DIR, this.replica)],
        `${this.replica}: pruned ${pruned.length} acknowledged op${pruned.length === 1 ? '' : 's'}`
      );
    return pruned;
  }

  /** This replica's own entries on the branch, read from its segments only. */
  readOwn(): LogEntry[] {
    const dir = join(this.dir, FED_DIR, this.replica);
    return this.segments(this.replica)
      .flatMap((name) => completeLines(join(dir, name)).map(parseEntry))
      .filter((e): e is LogEntry => e !== null && e.replica === this.replica);
  }

  /** The bytes under fed/ and ops/, for the branch-size warning. */
  sizeBytes(): number | null {
    if (!existsSync(this.dir)) return null;
    return [FED_DIR, OPS_DIR].reduce(
      (sum, sub) => sum + treeBytes(join(this.dir, sub)),
      0
    );
  }

  // One replica's segment files, by name. A name orders nothing (FW-R23);
  // only regular files under the segment pattern are read.
  private segments(replica: string): string[] {
    const dir = join(this.dir, FED_DIR, replica);
    return listDir(dir)
      .filter((name) => SEGMENT.test(name) && regularFile(join(dir, name)))
      .sort();
  }

  // The first segment name from `seq` up that no file of this replica uses.
  private unusedName(seq: number): string {
    const dir = join(this.dir, FED_DIR, this.replica);
    let n = seq;
    // A link or other non-file in the way is not a file: ownFile replaces it.
    while (regularFile(join(dir, segmentName(n)))) n += 1;
    return segmentName(n);
  }

  /**
   * Brings in what everyone else has pushed, then pushes this replica's log.
   * A push the remote rejects because someone pushed in between is retried
   * once after pulling again; failing that, the next pass tries.
   */
  async exchange(): Promise<RepoSyncResult> {
    const pulled = await this.pull();
    if (pulled !== null) return { pushed: false, offline: pulled };
    for (let attempt = 0; attempt < 2; attempt++) {
      const push = await this.run([
        'push',
        '-q',
        'origin',
        `HEAD:${this.branch}`,
      ]);
      if (push.ok) return { pushed: true };
      const again = await this.pull();
      if (again !== null) return { pushed: false, offline: again };
    }
    return { pushed: false, offline: 'the remote kept rejecting the push' };
  }

  /** Fetches and merges the remote branch. Null on success, or why it
   *  failed. */
  async pull(): Promise<string | null> {
    const fetched = await this.run(['fetch', '-q', 'origin', this.branch]);
    if (!fetched.ok) {
      // A branch nobody has pushed yet is not an error: this push creates it.
      if (/couldn't find remote ref|not found/i.test(fetched.out)) return null;
      return fetched.out === '' ? 'git fetch failed' : fetched.out;
    }
    const merged = await this.run([
      ...IDENTITY,
      'merge',
      '-q',
      '--no-edit',
      '--allow-unrelated-histories',
      `origin/${this.branch}`,
    ]);
    if (!merged.ok) {
      // Cannot happen while every replica writes only its own file; if it
      // does, leave the clone as it was rather than half-merged.
      await this.run(['merge', '--abort']);
      return `could not merge the sync branch: ${merged.out}`;
    }
    return null;
  }

  /**
   * Everyone whose changes are on the branch, by person, with the clock of
   * their earliest change — which is their place in line for a seat. A
   * replica's log is append-only, so its first line is its earliest.
   */
  people(): Map<string, string> {
    const people = new Map<string, string>();
    for (const replica of this.v1Replicas()) {
      const text = readCapped(
        join(this.dir, OPS_DIR, `${replica}.jsonl`),
        MAX_V1_READ
      );
      const first = text?.split('\n').find((line) => line.trim() !== '');
      if (first === undefined) continue;
      let hlc: string;
      try {
        hlc = (JSON.parse(first) as BoardOp).hlc;
      } catch {
        continue;
      }
      const person = personOf(replica);
      const seen = people.get(person);
      if (seen === undefined || hlc < seen) people.set(person, hlc);
    }
    return people;
  }

  /** Every other replica's changes past where this one has read to. */
  readOthers(cursor: (replica: string) => number): BoardOp[] {
    const ops: BoardOp[] = [];
    for (const replica of this.v1Replicas()) {
      if (replica === this.replica) continue;
      const from = cursor(replica);
      for (const op of this.readV1(replica)) if (op.seq > from) ops.push(op);
    }
    return ops;
  }

  /** Every replica with a v1 log on the branch, this one included. */
  v1Replicas(): string[] {
    const dir = join(this.dir, OPS_DIR);
    return listDir(dir)
      .filter((file) => file.endsWith('.jsonl') && regularFile(join(dir, file)))
      .map((file) => file.slice(0, -'.jsonl'.length));
  }

  /** One replica's complete v1 lines, parsed, in file order. */
  readV1(replica: string): BoardOp[] {
    const text = readCapped(
      join(this.dir, OPS_DIR, `${replica}.jsonl`),
      MAX_V1_READ
    );
    if (text === null) return [];
    const ops: BoardOp[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let op: BoardOp;
      try {
        op = JSON.parse(line) as BoardOp;
      } catch {
        // A torn last line from a write that died partway: skip it, and
        // pick it up whole on a later pass once its writer finishes it.
        continue;
      }
      if (op.v === 1 && op.replica === replica) ops.push(op);
    }
    return ops;
  }
}

/**
 * The person a replica belongs to. A replica id is the owner's handle and
 * eight hex characters for the machine (ledger.ts), so one person syncing
 * from a laptop and a desktop is one person, not two.
 */
export function personOf(replica: string): string {
  return replica.replace(/-[0-9a-f]{8}$/, '');
}

// The lines before the last newline: a torn tail from an unfinished write is dropped.
function completeLines(file: string): string[] {
  const text = readCapped(file, MAX_SEGMENT_READ);
  if (text === null) return [];
  const end = text.lastIndexOf('\n');
  if (end < 0) return [];
  return text
    .slice(0, end)
    .split('\n')
    .filter((line) => line.trim() !== '');
}

// A v2 entry, or null for a line that is not JSON with v: 2.
function parseEntry(line: string): LogEntry | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return (parsed as { v?: unknown }).v === 2 ? (parsed as LogEntry) : null;
  } catch {
    return null;
  }
}

function parseAcks(text: string): SignedAcks | null {
  try {
    const a = JSON.parse(text) as Partial<SignedAcks>;
    const through = a.through as unknown;
    if (
      a.v !== 1 ||
      typeof a.replica !== 'string' ||
      typeof a.at !== 'string' ||
      typeof a.sig !== 'string' ||
      typeof through !== 'object' ||
      through === null ||
      Object.values(through).some((n) => !Number.isSafeInteger(n))
    )
      return null;
    return a as SignedAcks;
  } catch {
    return null;
  }
}

function sortedKeys(o: Record<string, number>): [string, number][] {
  return Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1));
}

function treeBytes(path: string): number {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return 0;
  if (!stat.isDirectory()) return stat.isFile() ? stat.size : 0;
  return readdirSync(path).reduce(
    (sum, name) => sum + treeBytes(join(path, name)),
    0
  );
}
