import {
  MAX_OP_BYTES,
  opHash,
  REPLICA_ID,
  stubOf,
  ZERO_HASH,
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
  consumedDigest,
  listDir,
  newStream,
  ownFile,
  readCapped,
  readHead,
  readRange,
  readStream,
  realDir,
  regularFile,
} from './safeFs.js';
import type { StreamState } from './safeFs.js';

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
// FW-R25: overrides every .gitattributes on the branch.
const ATTRIBUTES =
  '* -text -eol -filter -merge -diff -ident -working-tree-encoding\n';
// What fetch and push add to the person's config: no hooks, no LFS filter.
const NETWORK_ARGS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'filter.lfs.process=',
  '-c',
  'filter.lfs.smudge=',
  '-c',
  'filter.lfs.clean=',
  '-c',
  'filter.lfs.required=false',
];
const ISOLATED_GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
// Reads are size-capped: a segment never grows past one op over its limit, an
// acks.json is one small map, and a v1 log is read whole.
const MAX_SEGMENT_READ = SEGMENT_MAX_BYTES + MAX_OP_BYTES;
const MAX_ACKS_READ = 1024 * 1024;
// FW-R23: fresh segment bytes one pass reads per replica; the rest wait.
const READ_BUDGET_BYTES = 2 * MAX_SEGMENT_READ;
// FW-R29(1): lines over this are skipped, and the first file of a pass reads
// at least this much, so a bloated file only ever costs time.
const MAX_LINE_BYTES = 1024 * 1024;
const MIN_STREAM_CHUNK = 256 * 1024;
// How much of each member file's end is read first, every pass it changed.
const TAIL_BYTES = 1024 * 1024;
const TAIL_PASS_BYTES = 8 * 1024 * 1024;
// FW-R30(3): all partial lines together.
const MAX_PARTIAL_BYTES = 16 * 1024 * 1024;
// FW-R29(3): what every full scan together may read in one pass.
const SCAN_PASS_BYTES = 32 * 1024 * 1024;
// FW-R25: fresh bytes a pass reads across all replicas, the unknown ids it
// probes for a key op, and how much of each file a probe reads.
const TOTAL_READ_BYTES = 32 * 1024 * 1024;
const MAX_UNKNOWN_IDS = 8;
const KEY_PROBE_BYTES = 64 * 1024;
// The whole read cache, across replicas.
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
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

// A segment's parsed lines above `floor`, valid while its stat stamp holds.
interface CachedSegment {
  stamp: string;
  floor: number;
  lines: { line: string; entry: LogEntry }[];
  /** FW-R29(1): how far the file is read, resumed on the next pass. */
  stream: StreamState;
  /** The last line read, and whether any line above the floor was signed. */
  last: LogEntry | null;
  gave: boolean;
  /** The file's size when last read. */
  size: number;
  /** While a changed file's old prefix is checked, the size it had. */
  grewFrom: number | null;
  /** The commit whose blob the consumed prefix was read from. */
  commit: string | null;
  /** A stamp git showed to be a pure append since `commit`, to resume at. */
  appendStamp: string | null;
}

// What earlier reads learned of a segment, kept after its lines are dropped:
// the seq of its last line when that is its replica's signed op, and how many
// reads in a row gave no signed op above the cursor.
interface SegmentInfo {
  lastOwnSeq: number | null;
  idle: number;
}

/** What the pass knows that orders a replica's reads (FW-R23, I2). */
export interface ReadHints {
  /** Fresh segment bytes per replica a pass (READ_BUDGET_BYTES). */
  budget?: number;
  /** Per replica, the hash of the op its cursor stands on. */
  heads?: ReadonlyMap<string, string>;
  /** Whether an entry carries its replica's valid signature. */
  signedBy?: (e: LogEntry) => boolean;
  /** Replicas read in full, first; any other id is read only as far as its
   *  key op. Absent, every replica is known. */
  known?: ReadonlySet<string>;
  /** FW-R26(4): 0 for admitted members, 1 for other ids with a cursor, 2 for
   *  claim-only ids, read only to their key op and first roster op, a few a
   *  pass. Overrides `known`. */
  tier?: (replica: string) => number;
  /** Fresh bytes one pass reads across every replica (TOTAL_READ_BYTES). */
  totalBudget?: number;
  /** Unknown ids probed for a key op per pass (MAX_UNKNOWN_IDS). */
  maxUnknown?: number;
}

export class SyncRepo {
  private readonly segmentCache = new Map<string, CachedSegment>();
  private passBytes = 0;
  /** Where the next pass starts probing claim-only ids (FW-R26(4)). */
  private probeStart = 0;
  /** The commit the clone is at, as verifyAppends last saw it. */
  private head: string | null = null;
  /** The stamp of this replica's own files when last found clean. */
  private cleanStamp: string | null = null;
  /** Where the rotation of ids read in full, and of each id's tails, starts. */
  private fullStart = 0;
  private readonly tailStart = new Map<string, number>();
  /** Files read this daemon's life far over a segment's size (FW-R29(1)). */
  private readonly oversized = new Set<string>();
  /** FW-R29(3): the full scans' resumable reads, and this pass's budget. */
  private readonly scanCache = new Map<
    string,
    { stamp: string; stream: StreamState; entries: LogEntry[] }
  >();
  private scanLeft = SCAN_PASS_BYTES;
  private readonly rewritten = new Set<string>();
  /** Each file's tail lines, by its stat stamp. */
  private readonly tails = new Map<
    string,
    {
      stamp: string;
      size: number;
      lines: { line: string; entry: LogEntry; hash: string }[];
    }
  >();
  private tailBytes = 0;
  /** Per probed id, which of its files the next probe starts at. */
  private readonly probeFileStart = new Map<string, number>();
  private readonly segmentInfo = new Map<string, SegmentInfo>();
  /** Merges given up for the remote tree since the last takeResets(). */
  private resets: string[] = [];
  /** Per replica, passes in a row whose reads the budget cut short. */
  private readonly cutPasses = new Map<string, number>();

  constructor(
    readonly dir: string,
    private readonly remoteUrl: string,
    private readonly branch: string,
    private readonly replica: string,
    private readonly git: AsyncGitRunner
  ) {}

  // FW-R25: the sync clone is hostile. Checkout, merge and commit run with no
  // global or system config, so nothing the branch names (a filter, a merge
  // driver) has a definition. FW-R26(5): fetch and push alone run with the
  // person's own config (credentials, url, http, includes), with hooks and
  // LFS filters off.
  private async run(args: string[]): Promise<{ ok: boolean; out: string }> {
    const network = args[0] === 'fetch' || args[0] === 'push';
    const res = network
      ? await this.git(this.dir, [...NETWORK_ARGS, ...args])
      : await this.git(this.dir, args, ISOLATED_GIT_ENV);
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
      // Before anything is checked out: no branch .gitattributes applies.
      mkdirSync(join(this.dir, '.git', 'info'), { recursive: true });
      writeFileSync(join(this.dir, '.git', 'info', 'attributes'), ATTRIBUTES);
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
    // The branch's .gitattributes never filters, converts or merges a file.
    mkdirSync(join(this.dir, '.git', 'info'), { recursive: true });
    writeFileSync(join(this.dir, '.git', 'info', 'attributes'), ATTRIBUTES);
    if (!realDir(join(this.dir, OPS_DIR)))
      ownFile(this.dir, `${OPS_DIR}/.keep`);
  }

  /** Appends this replica's changes to its log and commits them. */
  async write(ops: BoardOp[]): Promise<void> {
    // B3: a flush that ran twice writes each op once; only an identical line
    // counts as written, so another line at its seq never stands in for it.
    const written = new Set(
      this.readV1(this.replica).map((o) => JSON.stringify(o))
    );
    ops = ops.filter((o) => !written.has(JSON.stringify(o)));
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

  /** FW-R30(2): whether this replica's own segments hold only lines of its
   *  own log; if not (lines put in, padding, a shift), they are removed and
   *  the log written afresh from `own`, committed. True when it rewrote. */
  async cleanOwn(own: readonly LogEntry[]): Promise<boolean> {
    // Read only when its own files changed since they were last found clean.
    const stamp = this.stampOf([this.replica]);
    if (stamp === this.cleanStamp) return false;
    const mine = new Set<string>();
    for (const e of own)
      try {
        mine.add(opHash(e));
      } catch {
        // An entry of its own log always hashes; nothing to keep otherwise.
      }
    const dir = join(this.dir, FED_DIR, this.replica);
    const names = this.segments(this.replica);
    let dirty = false;
    for (const name of names) {
      const file = join(dir, name);
      const size = lstatSync(file, { throwIfNoEntry: false })?.size ?? 0;
      const state = newStream();
      readStream(file, state, size + 1, MAX_LINE_BYTES, (line) => {
        const entry = parseEntry(line);
        let hash = '';
        try {
          hash = entry === null ? '' : opHash(entry);
        } catch {
          hash = '';
        }
        if (entry?.replica !== this.replica || !mine.has(hash)) dirty = true;
      });
      if (state.offset < size) dirty = true;
      if (dirty) break;
    }
    if (!dirty || own.length === 0) {
      this.cleanStamp = stamp;
      return false;
    }
    await this.run([
      'rm',
      '--cached',
      '-q',
      // Paths git no longer tracks are fine to miss.
      '--ignore-unmatch',
      '--',
      ...names.map((n) => join(FED_DIR, this.replica, n)),
    ]);
    for (const name of names) rmSync(join(dir, name), { force: true });
    await this.writeV2(own);
    return true;
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

  /** Every replica's v2 entries past its watermark, from its segment files,
   *  identical lines once. Files are storage, never order (FW-R23): the pass
   *  rebuilds each log by its prev chain. Unchanged files come from cache;
   *  changed ones are read within the budget (one file at least), first the
   *  one whose lines chain from the cursor head, then the ones whose last line
   *  is the replica's own signed op, newest first, then by name from the
   *  cursor, and last the ones that gave nothing signed before. A file the
   *  budget skips still serves the lines cached from its last read. */
  readV2(since: Watermarks, hints: ReadHints = {}): LogEntry[] {
    const budget = hints.budget ?? READ_BUDGET_BYTES;
    const signed = hints.signedBy ?? (() => true);
    const total = hints.totalBudget ?? TOTAL_READ_BYTES;
    const tierOf =
      hints.tier ??
      ((r: string) =>
        hints.known === undefined || hints.known.has(r) ? 0 : 2);
    const root = join(this.dir, FED_DIR);
    const out: LogEntry[] = [];
    const live = new Set<string>();
    this.passBytes = 0;
    this.scanLeft = SCAN_PASS_BYTES;
    this.tailBytes = 0;
    const all = listDir(root).filter(
      (r) => REPLICA_ID.test(r) && realDir(join(root, r))
    );
    const tiers = new Map(all.map((r) => [r, tierOf(r)]));
    // FW-R30(4): members first; the other ids read in full rotate across
    // passes, so no listing order starves one.
    const members = all.filter((r) => (tiers.get(r) ?? 2) === 0);
    const others = all.filter((r) => (tiers.get(r) ?? 2) === 1);
    const turn = others.length === 0 ? 0 : this.fullStart % others.length;
    this.fullStart = turn + 1;
    const full = [...members, ...others.slice(turn), ...others.slice(0, turn)];
    // Each of those others gets a fair share of the pass.
    const share = Math.max(
      MIN_STREAM_CHUNK,
      Math.floor(total / Math.max(1, others.length))
    );
    // Claim-only and unknown ids: a few a pass, from where the last stopped.
    const probe = all.filter((r) => (tiers.get(r) ?? 2) >= 2);
    const cap = Math.min(hints.maxUnknown ?? MAX_UNKNOWN_IDS, probe.length);
    const start = probe.length === 0 ? 0 : this.probeStart % probe.length;
    const probed = [...probe.slice(start), ...probe.slice(0, start)].slice(
      0,
      cap
    );
    this.probeStart = start + cap;
    for (const replica of full) {
      const cursor = since.get(replica) ?? 0;
      const head = hints.heads?.get(replica);
      const files: { file: string; stamp: string; size: number }[] = [];
      for (const name of hintOrder(this.segments(replica), cursor)) {
        const file = join(root, replica, name);
        const st = lstatSync(file, { throwIfNoEntry: false });
        if (st === undefined) continue;
        live.add(file);
        const stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
        files.push({ file, stamp, size: st.size });
      }
      const stale = files.filter(({ file, stamp }) => {
        const held = this.segmentCache.get(file);
        return (
          held === undefined ||
          held.stamp !== stamp ||
          held.floor > cursor ||
          !held.stream.done
        );
      });
      const rank = (file: string): [number, number] => {
        const held = this.segmentCache.get(file);
        const info = this.segmentInfo.get(file);
        if (
          head !== undefined &&
          held?.lines.some((l) => l.entry.prev === head) === true
        )
          return [0, 0];
        if (info?.lastOwnSeq != null) return [1, -info.lastOwnSeq];
        if ((info?.idle ?? 0) > 0) return [3, info?.idle ?? 0];
        return [2, 0];
      };
      const order = stale
        .map((f, i) => ({ ...f, i, r: rank(f.file) }))
        .sort((a, b) =>
          a.r[0] !== b.r[0]
            ? a.r[0] - b.r[0]
            : a.r[1] !== b.r[1]
              ? a.r[1] - b.r[1]
              : a.i - b.i
        );
      let spent = 0;
      let cut = false;
      for (const [n, f] of order.entries()) {
        // FW-R29(1): files stream from where they stopped, within the budget;
        // the first file of a pass always gets a chunk, so reads progress.
        const cap =
          (tiers.get(replica) ?? 0) === 0 ? budget : Math.min(budget, share);
        const allowance = Math.min(cap - spent, total - this.passBytes);
        if (allowance <= 0 && (n > 0 || this.passBytes > 0)) {
          cut = true;
          continue;
        }
        const used = this.readSegment(
          f.file,
          f.stamp,
          f.size,
          replica,
          cursor,
          signed,
          this.passBytes === 0
            ? Math.max(allowance, MIN_STREAM_CHUNK)
            : allowance
        );
        spent += used;
        this.passBytes += used;
        if (this.segmentCache.get(f.file)?.stream.done !== true) cut = true;
      }
      this.cutPasses.set(
        replica,
        cut ? (this.cutPasses.get(replica) ?? 0) + 1 : 0
      );
      const seen = new Set<string>();
      // FW-R29: the end of each file first, where new ops land, whatever was
      // put before them; chainFrom takes them with the rest. Tails have their
      // own budget: the file whose last line is the head goes first, then the
      // files that grew most.
      // FW-R30(4): the head's file first, then files whose tail held a key
      // or found op, then the rest in a rotating order; growth never wins.
      const holdsHead = (file: string) =>
        head !== undefined &&
        (this.tails
          .get(file)
          ?.lines.some((l) => l.entry.prev === head || l.hash === head) ??
          false);
      const holdsFounding = (file: string) =>
        this.tails
          .get(file)
          ?.lines.some(
            (l) =>
              l.entry.type === 'key' ||
              (l.entry.type === 'roster' &&
                ('body' in l.entry
                  ? (l.entry.body as { action?: unknown } | undefined)?.action
                  : undefined) === 'found')
          ) ?? false;
      const tailRank = (file: string) =>
        holdsHead(file) ? 0 : holdsFounding(file) ? 1 : 2;
      const spin =
        files.length === 0
          ? 0
          : (this.tailStart.get(replica) ?? 0) % files.length;
      this.tailStart.set(replica, spin + 1);
      const rotated = [...files.slice(spin), ...files.slice(0, spin)];
      const tailOrder = rotated
        .map((f, i) => ({ ...f, i }))
        .sort((x, y) => {
          const byRank = tailRank(x.file) - tailRank(y.file);
          return byRank !== 0 ? byRank : x.i - y.i;
        });
      for (const { file, stamp, size } of tailOrder)
        for (const { line, entry } of this.tailLines(
          file,
          stamp,
          size,
          replica
        ))
          if (entry.seq > cursor && !seen.has(line)) {
            seen.add(line);
            out.push(entry);
          }
      let kept = 0;
      for (const { file } of files) {
        const held = this.segmentCache.get(file);
        if (held === undefined) continue;
        for (const { line, entry } of held.lines) {
          if (entry.seq <= cursor || seen.has(line)) continue;
          seen.add(line);
          out.push(entry);
        }
        // Lines the cursor has passed go; past the budget, the file is read
        // again when its turn comes rather than held.
        if (held.floor < cursor) {
          held.lines = held.lines.filter((l) => l.entry.seq > cursor);
          held.floor = cursor;
        }
        // A partial line counts toward the cache too (FW-R30(3)).
        const bytes =
          held.lines.reduce((sum, l) => sum + l.line.length, 0) +
          held.stream.partial.length;
        if (kept + bytes > budget) this.segmentCache.delete(file);
        else kept += bytes;
      }
    }
    for (const replica of probed)
      out.push(...this.probeKeyOps(root, replica, total));
    for (const map of [this.segmentCache, this.segmentInfo, this.tails])
      for (const file of map.keys()) if (!live.has(file)) map.delete(file);
    this.capPartials();
    this.capCache();
    return out;
  }

  /** Each segment's name, size and change time under these replicas' ids
   *  (every replica when null): a stamp that moves when their files do. */
  stampOf(replicas: readonly string[] | null): string {
    const root = join(this.dir, FED_DIR);
    const ids =
      replicas ??
      listDir(root).filter((r) => REPLICA_ID.test(r) && realDir(join(root, r)));
    return ids
      .flatMap((replica) =>
        this.segments(replica).map((name) => {
          const st = lstatSync(join(root, replica, name), {
            throwIfNoEntry: false,
          });
          return `${replica}/${name}:${st?.size ?? 0}:${st?.mtimeMs ?? 0}`;
        })
      )
      .join(',');
  }

  /** The key and roster ops in these replicas' segments (every replica when
   *  null), streamed in resumable steps within one byte budget all scans share each
   *  pass (FW-R29(3)): FW-R28's search for a named key op or a founding no
   *  probe found. Returns what has been read so far. */
  scanFull(replicas: readonly string[] | null, budget?: number): LogEntry[] {
    if (budget !== undefined) this.scanLeft = budget;
    const root = join(this.dir, FED_DIR);
    const ids =
      replicas ??
      listDir(root).filter((r) => REPLICA_ID.test(r) && realDir(join(root, r)));
    const out: LogEntry[] = [];
    // Files gone from the branch leave the scan cache.
    for (const file of [...this.scanCache.keys()])
      if (lstatSync(file, { throwIfNoEntry: false }) === undefined)
        this.scanCache.delete(file);
    for (const replica of ids) {
      if (!REPLICA_ID.test(replica) || !realDir(join(root, replica))) continue;
      for (const name of this.segments(replica)) {
        const file = join(root, replica, name);
        const st = lstatSync(file, { throwIfNoEntry: false });
        if (st === undefined) continue;
        const stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
        let held = this.scanCache.get(file);
        // A changed file is scanned again from the start (FW-R30(1)); what
        // it gave before stays, each op once.
        if (held !== undefined && held.stamp !== stamp)
          held = { ...held, stamp, stream: newStream() };
        held ??= { stamp, stream: newStream(), entries: [] };
        this.scanCache.set(file, held);
        if (!held.stream.done && this.scanLeft > 0) {
          const h = held;
          const have = new Set(h.entries.map((e) => JSON.stringify(e)));
          this.scanLeft -= readStream(
            file,
            h.stream,
            this.scanLeft,
            MAX_LINE_BYTES,
            (line) => {
              const entry = parseEntry(line);
              if (
                entry?.replica === replica &&
                (entry.type === 'key' || entry.type === 'roster') &&
                !have.has(line)
              ) {
                have.add(line);
                h.entries.push(entry);
              }
            }
          );
        }
        out.push(...held.entries);
      }
    }
    return out;
  }

  // The complete lines in the last TAIL_BYTES of a file, from its first full
  // line there; read again only when the file changed.
  private tailLines(
    file: string,
    stamp: string,
    size: number,
    replica: string
  ): { line: string; entry: LogEntry; hash: string }[] {
    const held = this.tails.get(file);
    if (held?.stamp === stamp) return held.lines;
    const start = Math.max(0, size - TAIL_BYTES);
    // Out of this pass's tail budget: the old lines stand until next pass.
    if (this.tailBytes + (size - start) > TAIL_PASS_BYTES)
      return held?.lines ?? [];
    const bytes = readRange(file, start, size - start);
    this.tailBytes += bytes?.length ?? 0;
    const lines: { line: string; entry: LogEntry; hash: string }[] = [];
    if (bytes !== null) {
      let text = bytes.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      const end = text.lastIndexOf('\n');
      for (const line of end < 0 ? [] : text.slice(0, end).split('\n')) {
        const entry = parseEntry(line);
        if (entry?.replica !== replica) continue;
        let hash = '';
        try {
          hash = opHash(entry);
        } catch {
          continue;
        }
        lines.push({ line, entry, hash });
      }
    }
    this.tails.set(file, { stamp, size, lines });
    return lines;
  }

  /** Tail bytes the last readV2 read (TAIL_PASS_BYTES a pass at most). */
  lastTailBytes(): number {
    return this.tailBytes;
  }

  /** Replicas whose files were rewritten rather than appended to, since the
   *  last call (FW-R29). */
  takeRewritten(): string[] {
    const out = [...this.rewritten].sort();
    this.rewritten.clear();
    return out;
  }

  /** Drops the full scans' reads of these replicas' files (all when null):
   *  after a scan found what it looked for, and once founded (FW-R30(5)). */
  forgetScans(replicas: readonly string[] | null): void {
    const root = join(this.dir, FED_DIR);
    for (const file of [...this.scanCache.keys()]) {
      const replica = file.slice(root.length + 1).split('/')[0] ?? '';
      if (replicas === null || replicas.includes(replica))
        this.scanCache.delete(file);
    }
  }

  /** How many files the full scans hold, for tests. */
  scanCacheSize(): number {
    return this.scanCache.size;
  }

  /**
   * The git-verified append path: for each file read before whose stat
   * changed, `git diff --unified=0` from the commit it was read at to HEAD.
   * Only lines added after the lines already consumed make a pure append,
   * which readV2 then resumes from the offset; anything else (a deletion, a
   * change, an insertion in the consumed part) leaves the full re-read with
   * its prefix check. Git's object hashes make the diff the truth.
   */
  async verifyAppends(): Promise<void> {
    const head = await this.run(['rev-parse', 'HEAD']);
    const commit = head.ok ? head.out.trim() : null;
    if (commit !== null)
      for (const [file, held] of this.segmentCache) {
        if (held.commit === null || held.commit === commit) continue;
        const st = lstatSync(file, { throwIfNoEntry: false });
        if (st === undefined) continue;
        const stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
        if (stamp === held.stamp) continue;
        const rel = file.slice(this.dir.length + 1);
        const diff = await this.run([
          'diff',
          '--unified=0',
          '--no-color',
          // -diff in info/attributes marks every file binary; read it as text.
          '--text',
          '--no-ext-diff',
          '--no-textconv',
          held.commit,
          commit,
          '--',
          rel,
        ]);
        // A line read only in part counts as read: nothing may land before it.
        const { stream } = held;
        const mid = stream.skipping || stream.partial.length > 0;
        if (diff.ok && pureAppend(diff.out, stream.lines + (mid ? 1 : 0)))
          held.appendStamp = stamp;
      }
    this.head = commit;
  }

  /** Files seen far over the size any honest segment reaches, as
   *  `<replica>/<name>`, since the last call. */
  takeOversized(): string[] {
    const root = join(this.dir, FED_DIR);
    const out = [...this.oversized].map((f) => f.slice(root.length + 1));
    this.oversized.clear();
    return out;
  }

  /** Fresh segment bytes the last readV2 read. */
  lastPassBytes(): number {
    return this.passBytes;
  }

  // FW-R28: a claim-only or unknown id's key ops, found anywhere in each
  // file's first KEY_PROBE_BYTES, each with the next roster op after it (its
  // chain's first, which may be its recover). Every file, in no name order,
  // within the pass budget, from where the last pass stopped.
  private probeKeyOps(
    root: string,
    replica: string,
    total: number
  ): LogEntry[] {
    const out: LogEntry[] = [];
    const names = this.segments(replica);
    const start =
      names.length === 0
        ? 0
        : (this.probeFileStart.get(replica) ?? 0) % names.length;
    const turn = [...names.slice(start), ...names.slice(0, start)];
    let read = 0;
    for (const name of turn) {
      if (this.passBytes + KEY_PROBE_BYTES > total) break;
      read += 1;
      const head = readHead(join(root, replica, name), KEY_PROBE_BYTES);
      if (head === null) continue;
      this.passBytes += Buffer.byteLength(head);
      const lines = head
        .slice(0, Math.max(0, head.lastIndexOf('\n')))
        .split('\n');
      let wantRoster = false;
      for (const line of lines) {
        const entry = parseEntry(line);
        if (entry?.replica !== replica) continue;
        if (entry.type === 'key' && entry.prev === ZERO_HASH) {
          out.push(entry);
          wantRoster = true;
        } else if (wantRoster && entry.type === 'roster') {
          out.push(entry);
          wantRoster = false;
        }
      }
    }
    // Cut short by the pass budget: the next probe starts where this stopped.
    this.probeFileStart.set(replica, start + read);
    return out;
  }

  // Reads one segment into the cache and records what it showed.
  // Reads one segment onward from where it stopped, up to `allowance` bytes,
  // into the cache; returns the bytes read. A file rewritten under the read
  // (its bytes before the offset changed) starts over.
  private readSegment(
    file: string,
    stamp: string,
    size: number,
    replica: string,
    cursor: number,
    signed: (e: LogEntry) => boolean,
    allowance: number
  ): number {
    let held = this.segmentCache.get(file);
    if (held !== undefined && held.floor > cursor) held = undefined;
    if (
      held !== undefined &&
      held.stamp !== stamp &&
      held.appendStamp === stamp
    ) {
      // Git showed only lines added after the consumed prefix: carry on from
      // the offset, the running hash extended with the new bytes alone.
      held.stamp = stamp;
      held.appendStamp = null;
      held.stream.done = false;
    }
    if (held !== undefined && held.stamp !== stamp) {
      // FW-R30(1): the file changed, so its offset is not trusted. The read
      // starts over, checking the old consumed prefix as it goes; lines read
      // already stay, and a line seen twice is handed over once.
      const old = held;
      const verify =
        old.stream.offset > 0
          ? { at: old.stream.offset, digest: consumedDigest(old.stream) }
          : null;
      held = {
        ...old,
        stream: newStream(verify),
        grewFrom: verify === null ? null : old.size,
        appendStamp: null,
      };
      this.segmentCache.set(file, held);
    }
    if (held === undefined) {
      held = {
        stamp,
        floor: cursor,
        lines: [],
        stream: newStream(),
        last: null,
        gave: false,
        size,
        grewFrom: null,
        commit: null,
        appendStamp: null,
      };
      this.segmentCache.set(file, held);
    }
    held.stamp = stamp;
    held.size = size;
    held.commit = this.head;
    if (size > MAX_SEGMENT_READ) this.oversized.add(file);
    const h = held;
    const have = new Set(h.lines.map((l) => l.line));
    const used = readStream(
      file,
      h.stream,
      allowance,
      MAX_LINE_BYTES,
      (line) => {
        const entry = parseEntry(line);
        h.last = entry;
        if (entry?.replica !== replica || entry.seq <= cursor) return;
        if (have.has(line)) return;
        have.add(line);
        h.lines.push({ line, entry });
        if (signed(entry)) h.gave = true;
      }
    );
    // An old prefix that no longer matches, in a file that grew, was
    // rewritten, not appended to (pruning only ever shrinks a file).
    const same = h.stream.verify?.same ?? null;
    if (h.grewFrom !== null && same !== null) {
      if (!same && size >= h.grewFrom) this.rewritten.add(replica);
      h.grewFrom = null;
    }
    if (h.stream.done) {
      const before = this.segmentInfo.get(file);
      const last = h.last;
      this.segmentInfo.set(file, {
        lastOwnSeq:
          last !== null && last.replica === replica && signed(last)
            ? last.seq
            : null,
        idle: h.gave ? 0 : (before?.idle ?? 0) + 1,
      });
      h.gave = false;
    }
    return used;
  }

  // FW-R30(3): partial lines are capped in total; the oldest go first, and a
  // file whose partial goes reads again from its start.
  private capPartials(): void {
    let total = this.partialBytes();
    for (const cache of [this.scanCache, this.segmentCache])
      for (const [file, held] of cache) {
        if (total <= MAX_PARTIAL_BYTES) return;
        if (held.stream.partial.length === 0) continue;
        total -= held.stream.partial.length;
        cache.delete(file);
      }
  }

  // Keeps the whole read cache under MAX_CACHE_BYTES, dropping files in
  // insertion order (the oldest reads first).
  private capCache(): void {
    let total = this.cachedBytes();
    for (const [file, held] of this.segmentCache) {
      if (total <= MAX_CACHE_BYTES) return;
      total -= held.lines.reduce((sum, l) => sum + l.line.length, 0);
      this.segmentCache.delete(file);
    }
  }

  /** Why each merge since the last call reset to the remote tree. */
  takeResets(): string[] {
    return this.resets.splice(0);
  }

  /** Replicas whose reads the budget cut short on two or more passes in a
   *  row: their directories may hold files that crowd out the real log. */
  starvedReplicas(): string[] {
    return [...this.cutPasses]
      .filter(([, n]) => n >= 2)
      .map(([replica]) => replica)
      .sort();
  }

  /** Characters of segment lines the read cache holds. */
  cachedBytes(): number {
    let total = this.partialBytes();
    for (const held of this.segmentCache.values())
      for (const l of held.lines) total += l.line.length;
    return total;
  }

  /** Bytes held as the starts of lines a read stopped inside (FW-R30(3)). */
  partialBytes(): number {
    let total = 0;
    for (const held of this.segmentCache.values())
      total += held.stream.partial.length;
    for (const held of this.scanCache.values())
      total += held.stream.partial.length;
    return total;
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
      // FW-R25: someone wrote into this replica's files, so its commits
      // conflict for good. Take the remote tree (never force-push it) and
      // write this replica's own lines back on top.
      await this.run(['merge', '--abort']);
      const ownV1 = this.readV1(this.replica);
      const reset = await this.run([
        'reset',
        '-q',
        '--hard',
        `origin/${this.branch}`,
      ]);
      if (!reset.ok) return `could not merge the sync branch: ${merged.out}`;
      await this.write(ownV1);
      this.resets.push(merged.out);
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

// Segment names from the one named at or below cursor + 1, then later ones,
// then earlier ones newest first: where the chain from the cursor most likely is.
function hintOrder(names: string[], cursor: number): string[] {
  let start = 0;
  names.forEach((name, i) => {
    if (Number(name.slice(0, 12)) <= cursor + 1) start = i;
  });
  return [...names.slice(start), ...names.slice(0, start).reverse()];
}

// Whether a `git diff --unified=0` only adds lines after the first `lines`
// lines: every hunk removes nothing and inserts after line `lines` or later.
function pureAppend(diff: string, lines: number): boolean {
  const hunks = diff
    .split('\n')
    .filter((l) => l.startsWith('@@ '))
    .map((l) => /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(l));
  if (hunks.length === 0) return false;
  if (/^(Binary files|old mode|new mode|deleted file|new file)/m.test(diff))
    return false;
  return hunks.every((h) => {
    if (h === null) return false;
    const start = Number(h[1]);
    const removed = h[2] === undefined ? 1 : Number(h[2]);
    return removed === 0 && start >= lines;
  });
}
