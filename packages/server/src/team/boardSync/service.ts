import type { BoardOp } from './engine.js';
import type { SyncLedger, SyncProblem } from './ledger.js';
import type { SyncRepo } from './repo.js';
import { personOf } from './repo.js';
import type { SyncedTaskStore } from './syncedStore.js';

// When board sync runs, and what it reports. One pass: write this replica's
// new changes to its log, exchange with the remote, fold in everyone else's.
// Passes run soon after a local change (debounced, so a burst of edits is one
// push) and on an interval otherwise, so a teammate's change arrives without
// anyone here doing anything. Never two at once: a pass that is asked for
// while one runs is run straight after it.
//
// Licensed under the Elastic License 2.0 (../LICENSE). A board is shared by
// as many people as the license covers, earliest first: the first people to
// sync keep syncing with each other, and someone past the seats pauses —
// nothing of theirs is pushed, nobody applies theirs, and nothing is deleted,
// so adding seats later picks everything up where it stopped.

/** What `GET /api/board-sync` reports. */
export interface SyncStatus {
  enabled: true;
  replica: string;
  remote: string;
  branch: string;
  lastSyncAt: string | null;
  /** Why the last pass could not reach the remote, if it could not. Local
   *  work carries on either way; this is only ever about the exchange. */
  lastError: string | null;
  /** Changes made here and not yet pushed. */
  pending: number;
  /** Changes from others applied since the daemon started. */
  applied: number;
  problems: SyncProblem[];
  /** People sharing the branch, and how many the license covers. */
  people: number;
  seats: number;
  /** Why this machine is not syncing although the remote is fine: it is
   *  past the license's seats. Null while it syncs. */
  paused: string | null;
}

interface ServiceOptions {
  store: SyncedTaskStore;
  ledger: SyncLedger;
  repo: SyncRepo;
  remote: string;
  branch: string;
  intervalMs: number;
  /** Called when a pass changed the board, so the daemon can rebuild its
   *  cache and tell every client — the same as a local edit does. */
  onBoardChanged: () => void;
  /** How many people the license covers, asked on every pass. */
  seats: () => number;
  /** The sentence to pause with when this machine is past the seats. */
  seatMessage: (seats: number) => string;
  debounceMs?: number;
  now?: () => Date;
}

export class BoardSyncService {
  private lastSyncAt: string | null = null;
  private lastError: string | null = null;
  private paused: string | null = null;
  private people = 0;
  private applied = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private ready: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly opts: ServiceOptions) {}

  /** Starts the interval and runs a first pass. */
  start(): void {
    this.interval = setInterval(
      () => void this.syncNow(),
      this.opts.intervalMs
    );
    void this.syncNow();
  }

  stop(): void {
    this.stopped = true;
    if (this.interval !== null) clearInterval(this.interval);
    if (this.debounce !== null) clearTimeout(this.debounce);
  }

  /** A local change happened: sync shortly, once the burst is over. */
  notifyLocalChange(): void {
    if (this.stopped) return;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.syncNow();
    }, this.opts.debounceMs ?? 2000);
  }

  /** Runs a pass now, or right after the one in flight. Resolves when the
   *  pass this call asked for has finished. */
  async syncNow(): Promise<void> {
    if (this.stopped) return;
    if (this.running !== null) {
      this.again = true;
      await this.running;
      if (this.running !== null) await this.running;
      return;
    }
    this.running = this.pass().finally(() => {
      this.running = null;
    });
    await this.running;
    if (this.again) {
      this.again = false;
      await this.syncNow();
    }
  }

  status(): SyncStatus {
    return {
      enabled: true,
      replica: this.opts.ledger.replica,
      remote: this.opts.remote,
      branch: this.opts.branch,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      pending: this.opts.ledger.outbox().length,
      applied: this.applied,
      problems: this.opts.ledger.problems(),
      people: this.people,
      seats: this.opts.seats(),
      paused: this.paused,
    };
  }

  private async pass(): Promise<void> {
    const { ledger, repo } = this.opts;
    try {
      this.ready ??= repo.ensure();
      await this.ready;

      // 0. Whether the license covers this machine's owner, by the branch as
      // last seen. Past the seats, nothing goes out and nothing comes in.
      const outbox = ledger.outbox();
      const seats = this.opts.seats();
      if (!this.covered(seats, outbox[0]?.hlc).has(this.me())) {
        this.paused = this.opts.seatMessage(seats);
        this.lastSyncAt = (this.opts.now?.() ?? new Date()).toISOString();
        return;
      }
      this.paused = null;

      // 1. This replica's new changes, into its own log.
      if (outbox.length > 0) {
        await repo.write(outbox);
        ledger.sent(outbox.at(-1)?.seq ?? 0);
      }

      // 2. Everyone else's, and ours out to them.
      const exchanged = await repo.exchange();
      this.lastError = exchanged.offline ?? null;

      // 3. Fold theirs in, oldest first across every replica — the order
      // does not change the result (see core's boardSync.ts), but applying
      // in clock order means each task is rewritten fewer times.
      // Only from people the license covers, now that the exchange has
      // shown everyone on the branch; the rest keep their place (their
      // cursors do not move) for when there are seats for them.
      const covered = this.covered(seats);
      const incoming = repo
        .readOthers((replica) => ledger.cursor(replica))
        .filter((op) => covered.has(personOf(op.replica)))
        .sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
      const changed = this.apply(incoming);
      this.lastSyncAt = (this.opts.now?.() ?? new Date()).toISOString();
      if (changed) this.opts.onBoardChanged();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  private me(): string {
    return personOf(this.opts.ledger.replica);
  }

  /**
   * The people the license covers: everyone on the branch plus this
   * machine's owner, earliest first change first, as many as there are
   * seats. `pendingHlc` is this machine's first unsent change, which is its
   * place in line when nothing of its own is on the branch yet.
   */
  private covered(seats: number, pendingHlc?: string): Set<string> {
    const people = this.opts.repo.people();
    const me = this.me();
    if (!people.has(me)) {
      // Nothing of ours pushed yet: we join the line now, at the back.
      people.set(me, pendingHlc ?? '\uffff');
    }
    this.people = people.size;
    return new Set(
      [...people.entries()]
        .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
        .slice(0, seats)
        .map(([person]) => person)
    );
  }

  // Applies changes and advances each replica's cursor, all or nothing per
  // pass: a crash partway leaves the cursors where the board is, so the next
  // pass re-reads from there. Re-applying a change is harmless.
  private apply(ops: BoardOp[]): boolean {
    if (ops.length === 0) return false;
    const { ledger, store } = this.opts;
    let changed = false;
    ledger.atomically(() => {
      const reached = new Map<string, number>();
      // A held change stops its replica here; its cursor waits for it (FW-R21).
      const held = new Set<string>();
      for (const op of ops) {
        if (held.has(op.replica)) continue;
        const result = store.applyRemote(op);
        if (result.problem !== undefined) {
          ledger.recordProblem(
            op.task,
            result.problem,
            new Date().toISOString()
          );
        }
        if (result.held === true) {
          held.add(op.replica);
          continue;
        }
        if (result.changed) {
          changed = true;
          this.applied += 1;
        }
        reached.set(op.replica, Math.max(reached.get(op.replica) ?? 0, op.seq));
      }
      for (const [replica, seq] of reached) ledger.setCursor(replica, seq);
    });
    return changed;
  }
}
