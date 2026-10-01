import { REPLICA_ID, stubOf } from '@dispatch/protocol/federation';
import type { FederatedOp, LogEntry } from '@dispatch/protocol/federation';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { AsyncGitRunner } from '../../sync/worktree.js';
import type { Watermarks } from '../federation/transport.js';
import type { BoardOp } from './engine.js';

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
    mkdirSync(join(this.dir, OPS_DIR), { recursive: true });
  }

  /** Appends this replica's changes to its log and commits them. */
  async write(ops: BoardOp[]): Promise<void> {
    if (ops.length === 0) return;
    const file = join(this.dir, OPS_DIR, `${this.replica}.jsonl`);
    appendFileSync(file, ops.map((op) => `${JSON.stringify(op)}\n`).join(''));
    await this.commitPaths(
      [join(OPS_DIR, `${this.replica}.jsonl`)],
      `${this.replica}: ${ops.length} change${ops.length === 1 ? '' : 's'}`
    );
  }

  private async commitPaths(paths: string[], message: string): Promise<void> {
    await this.run(['add', ...paths]);
    const committed = await this.run([
      ...IDENTITY,
      'commit',
      '-q',
      '--no-verify',
      '-m',
      message,
    ]);
    if (!committed.ok)
      throw new Error(`could not commit sync log: ${committed.out}`);
  }

  /** Appends this replica's v2 ops to its current segment, rolling over at
   *  the limits, and commits; the next exchange pushes them. */
  async writeV2(
    entries: readonly LogEntry[],
    limits = { ops: SEGMENT_MAX_OPS, bytes: SEGMENT_MAX_BYTES }
  ): Promise<void> {
    if (entries.length === 0) return;
    const dir = join(this.dir, FED_DIR, this.replica);
    mkdirSync(dir, { recursive: true });
    let current = this.segments(this.replica).at(-1) ?? null;
    let count = current === null ? 0 : completeLines(join(dir, current)).length;
    let size = current === null ? 0 : statSync(join(dir, current)).size;
    for (const e of entries) {
      const line = `${JSON.stringify(e)}\n`;
      const bytes = Buffer.byteLength(line);
      if (
        current === null ||
        count >= limits.ops ||
        size + bytes > limits.bytes
      ) {
        current = segmentName(e.seq);
        count = 0;
        size = 0;
      }
      appendFileSync(join(dir, current), line);
      count += 1;
      size += bytes;
    }
    await this.commitPaths(
      [join(FED_DIR, this.replica)],
      `${this.replica}: ${entries.length} signed op${entries.length === 1 ? '' : 's'}`
    );
  }

  /** Every replica's v2 entries past its watermark, reading only from the
   *  segment holding watermark + 1 onward. Torn last lines are skipped. */
  readV2(since: Watermarks): LogEntry[] {
    const root = join(this.dir, FED_DIR);
    if (!existsSync(root)) return [];
    const out: LogEntry[] = [];
    for (const replica of readdirSync(root)) {
      if (!REPLICA_ID.test(replica)) continue;
      const cursor = since.get(replica) ?? 0;
      const segments = this.segments(replica);
      let start = 0;
      segments.forEach((name, i) => {
        if (Number(name.slice(0, 12)) <= cursor + 1) start = i;
      });
      for (const name of segments.slice(start)) {
        for (const line of completeLines(join(root, replica, name))) {
          const entry = parseEntry(line);
          if (entry !== null && entry.replica === replica && entry.seq > cursor)
            out.push(entry);
        }
      }
    }
    return out;
  }

  /** Writes this replica's acks.json and commits it, only when `through` changed. */
  async writeAcks(acks: SignedAcks): Promise<void> {
    const dir = join(this.dir, FED_DIR, this.replica);
    const file = join(dir, ACKS);
    const held = this.readAcks().get(this.replica);
    if (
      held !== undefined &&
      JSON.stringify(sortedKeys(held.through)) ===
        JSON.stringify(sortedKeys(acks.through))
    )
      return;
    mkdirSync(dir, { recursive: true });
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
    if (!existsSync(root)) return out;
    for (const replica of readdirSync(root)) {
      const file = join(root, replica, ACKS);
      if (!REPLICA_ID.test(replica) || !existsSync(file)) continue;
      const acks = parseAcks(readFileSync(file, 'utf8'));
      if (acks !== null && acks.replica === replica) out.set(replica, acks);
    }
    return out;
  }

  /** Replaces this replica's full mail and state ops that `prune` accepts
   *  with their signed stubs, committing once; how many it replaced. */
  async pruneOwn(prune: (op: FederatedOp) => boolean): Promise<number> {
    const dir = join(this.dir, FED_DIR, this.replica);
    let replaced = 0;
    for (const name of this.segments(this.replica)) {
      const file = join(dir, name);
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
        replaced += 1;
        return JSON.stringify(stubOf(entry));
      });
      if (changed) writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
    }
    if (replaced > 0)
      await this.commitPaths(
        [join(FED_DIR, this.replica)],
        `${this.replica}: pruned ${replaced} acknowledged op${replaced === 1 ? '' : 's'}`
      );
    return replaced;
  }

  /** The bytes under fed/ and ops/, for the branch-size warning. */
  sizeBytes(): number | null {
    if (!existsSync(this.dir)) return null;
    return [FED_DIR, OPS_DIR].reduce(
      (sum, sub) => sum + treeBytes(join(this.dir, sub)),
      0
    );
  }

  // One replica's segment names, sorted by their first seq.
  private segments(replica: string): string[] {
    const dir = join(this.dir, FED_DIR, replica);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => SEGMENT.test(f))
      .sort();
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
    const dir = join(this.dir, OPS_DIR);
    const people = new Map<string, string>();
    if (!existsSync(dir)) return people;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      const replica = file.slice(0, -'.jsonl'.length);
      const first = readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .find((line) => line.trim() !== '');
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
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => file.slice(0, -'.jsonl'.length));
  }

  /** One replica's complete v1 lines, parsed, in file order. */
  readV1(replica: string): BoardOp[] {
    const file = join(this.dir, OPS_DIR, `${replica}.jsonl`);
    if (!existsSync(file)) return [];
    const ops: BoardOp[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
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
  const text = readFileSync(file, 'utf8');
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
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce(
    (sum, name) => sum + treeBytes(join(path, name)),
    0
  );
}
