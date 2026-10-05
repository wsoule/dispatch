import type { DeliveryEngine, MessageStore } from '@dispatch/protocol';
import { hlcWallMs } from '@dispatch/protocol/federation';
import type { FederatedOp, PresenceBody } from '@dispatch/protocol/federation';

import { RosterError } from './roster.js';
import type { RosterService } from './roster.js';
import type { Collector, OpHandler, StageContext } from './service.js';
import type { FedStore } from './store.js';
import { dropNote, presenceBody } from './validate.js';

const PRESENCE_REPLICA_EVERY_MS = 60 * 60 * 1000;
const ENDED_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** What the orchestrator says about a run that started or ended. */
export interface RunInfo {
  id: string;
  taskId: string | null;
  kind?: string;
}

type RunBody = Extract<PresenceBody, { kind: 'run' }>;

/** A claimant's latest claim on a contested run. */
interface Claim {
  body: RunBody;
  hlc: string;
}

interface RunRow {
  run: string;
  replica: string;
  task: string | null;
  run_kind: string;
  live: number;
  waiting_on: string | null;
  hlc: string;
}

// Where each run is live and each replica's build, device and clock skew:
// `presence` ops out (runs at once, the replica at boot and hourly) and in.
export class Presence implements Collector, OpHandler {
  readonly order = 1;
  readonly type = 'presence';
  private lastReplicaAt: number | null = null;

  constructor(
    private deps: {
      fed: FedStore;
      roster: RosterService;
      build: string;
      device: string;
      /** Whether this daemon has, or had, a run with this id. */
      knowsRun: (runId: string) => boolean;
      /** Whether this daemon's run is live now. */
      isLive: (runId: string) => boolean;
      now: () => Date;
      /** A live execute run bound for a task (Task 16 forwards held mail). */
      onLiveRun?: (task: string, replica: string, hlc: string) => void;
      /** A presence op was queued: ask for a pass. */
      changed?: () => void;
    }
  ) {}

  /** Wires held task mail in once messaging is open. */
  setOnLiveRun(fn: (task: string, replica: string, hlc: string) => void): void {
    this.deps.onLiveRun = fn;
  }

  runStarted(meta: RunInfo): void {
    this.publishRun(meta, true, null);
  }

  runEnded(meta: RunInfo): void {
    this.publishRun(meta, false, null);
  }

  /** The handle a run waits on, or null when it waits on nobody. */
  waitingOn(runId: string, handle: string | null): void {
    const row = this.row(runId);
    if (row?.replica !== this.deps.fed.replica || row.live !== 1) return;
    if (row.waiting_on === handle) return;
    this.publishRun(
      { id: runId, taskId: row.task, kind: row.run_kind },
      true,
      handle
    );
  }

  collect(now: Date): void {
    if (!this.canPublish()) return;
    const { fed } = this.deps;
    if (
      this.lastReplicaAt === null ||
      now.getTime() - this.lastReplicaAt >= PRESENCE_REPLICA_EVERY_MS
    ) {
      const body: PresenceBody = {
        kind: 'replica',
        build: this.deps.build,
        device: this.deps.device,
        wall: now.getTime(),
      };
      fed.append({ type: 'presence', body });
      this.lastReplicaAt = now.getTime();
    }
    // A run of this machine's that is no longer live (a crash, a restart)
    // ends in the team's view too.
    for (const row of fed.db
      .query<RunRow, [string]>(
        'SELECT * FROM fed_runs WHERE replica = ? AND live = 1'
      )
      .all(fed.replica))
      if (!this.deps.isLive(row.run))
        this.publishRun(
          { id: row.run, taskId: row.task, kind: row.run_kind },
          false,
          null
        );
    const cutoff = now.getTime() - ENDED_RUN_RETENTION_MS;
    for (const row of fed.db
      .query<RunRow, []>('SELECT * FROM fed_runs WHERE live = 0')
      .all())
      if ((hlcWallMs(row.hlc) ?? 0) < cutoff) {
        fed.db.query('DELETE FROM fed_runs WHERE run = ?').run(row.run);
        fed.db
          .query(
            'INSERT OR REPLACE INTO fed_run_tombs (run, replica) VALUES (?, ?)'
          )
          .run(row.run, row.replica);
      }
  }

  stage(op: FederatedOp, ctx: StageContext): 'applied' | 'parked' | 'dropped' {
    // FW-R32(3): a body that is not exactly an honest one is refused.
    const body = presenceBody(op.body);
    if (body === null) {
      dropNote(
        this.deps.fed,
        'malformed',
        op.replica,
        `${this.deps.roster.label(op.replica)}'s presence at seq ${op.seq} is malformed; it was dropped`
      );
      return 'dropped';
    }
    if (body.kind === 'replica') {
      this.deps.fed.db
        .query(
          'INSERT OR REPLACE INTO fed_replicas (replica, build, device, last_hlc, skew_ms) VALUES (?, ?, ?, ?, ?)'
        )
        .run(
          op.replica,
          body.build,
          body.device,
          op.hlc,
          Math.round(body.wall - ctx.now.getTime())
        );
      return 'applied';
    }
    if (body.kind === 'resolve') return this.stageResolve(op, body, ctx);
    return this.stageRun(op, body, ctx);
  }

  private stageRun(
    op: FederatedOp,
    body: Extract<PresenceBody, { kind: 'run' }>,
    ctx: StageContext
  ): 'applied' | 'dropped' {
    const { fed, roster } = this.deps;
    const p = op.replica;
    const bound = this.row(body.run);
    const claims = ctx.evidence.runs.get(body.run) ?? [p];
    let holder: string | null = null;
    // A pruned run id stays its runner's (FW-R32(8)).
    const tomb = fed.db
      .query<{ replica: string }, [string]>(
        'SELECT replica FROM fed_run_tombs WHERE run = ?'
      )
      .get(body.run);
    if (tomb !== null && tomb.replica !== p) holder = tomb.replica;
    else if (bound !== null && bound.replica !== p) holder = bound.replica;
    else if (bound === null && this.deps.knowsRun(body.run))
      holder = fed.replica;
    if (holder !== null) {
      this.conflict(
        body.run,
        `${roster.label(p)} claims run ${body.run}, already running on ${roster.label(holder)}`,
        [p, holder]
      );
      // Kept, so an admin's resolution can still name this claimant.
      const known = this.rivalClaims(body.run);
      known[p] = { body, hlc: op.hlc };
      fed.db
        .query(
          'INSERT OR REPLACE INTO fed_run_claims (run, claims_json) VALUES (?, ?)'
        )
        .run(body.run, JSON.stringify(known));
      return 'dropped';
    }
    if (bound === null && this.contested(op, body, claims, ctx))
      return 'dropped';
    fed.db
      .query(
        'INSERT OR REPLACE INTO fed_runs (run, replica, task, run_kind, live, waiting_on, hlc) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        body.run,
        p,
        body.task,
        body.runKind,
        body.live ? 1 : 0,
        body.waitingOn ?? null,
        op.hlc
      );
    if (body.live && body.runKind === 'execute' && body.task !== null)
      this.deps.onLiveRun?.(body.task, p, op.hlc);
    return 'applied';
  }

  // Whether an unbound run is contested: two first claims in one pull open a
  // conflict, and it stays open, whoever posts next, until at most `p` still
  // stands among its claimants (an admin revoked the rest).
  private contested(
    op: FederatedOp,
    body: RunBody,
    claims: string[],
    ctx: StageContext
  ): boolean {
    const { fed, roster } = this.deps;
    const run = body.run;
    const held = this.claimsOf(run);
    const known: Record<string, Claim | null> = { ...(held ?? {}) };
    for (const r of claims) known[r] ??= null;
    known[op.replica] = { body, hlc: op.hlc };
    const all = Object.keys(known).sort();
    if (held === null && all.length < 2) return false;
    const standing = all.filter(
      (r) => ctx.view.members.has(r) && !ctx.view.revoked.has(r)
    );
    if (
      standing.length === 1 &&
      claims.length === 1 &&
      standing[0] === claims[0]
    ) {
      fed.db.query('DELETE FROM fed_run_conflicts WHERE run = ?').run(run);
      fed.clearProblem(`run-conflict:${run}`);
      return false;
    }
    fed.db
      .query(
        'INSERT OR REPLACE INTO fed_run_conflicts (run, replicas_json) VALUES (?, ?)'
      )
      .run(run, JSON.stringify(known));
    if (held === null)
      this.conflict(
        run,
        `${all
          .map((r) => roster.label(r))
          .sort()
          .join(
            ' and '
          )} each claim run ${run} first; it is bound to neither until an admin revokes all but one`,
        all
      );
    return true;
  }

  /** An admin binds a contested run to one of its claimants, on every
   *  machine; this one at once. */
  resolve(run: string, replica: string): void {
    const { fed, roster } = this.deps;
    const me = roster.view()?.members.get(fed.replica);
    if (me?.role !== 'admin' || !this.canPublish())
      throw new RosterError(
        'forbidden',
        'only an admin resolves a run conflict'
      );
    const bound = this.row(run);
    const claim =
      bound?.replica === replica
        ? { body: this.bodyOf(bound), hlc: bound.hlc }
        : (this.claimsOf(run)?.[replica] ??
          this.rivalClaim(run, replica) ??
          undefined);
    if (claim === undefined)
      throw new RosterError(
        'invalid',
        `${replica} is not a claimant of a conflict over run ${run}`
      );
    if (claim === null)
      throw new RosterError(
        'conflict',
        `${replica}'s claim on run ${run} has not arrived here yet; sync, then try again`
      );
    const body: PresenceBody = { kind: 'resolve', run, replica };
    fed.append({ type: 'presence', body });
    this.bindResolved(run, replica, claim);
    this.deps.changed?.();
  }

  private stageResolve(
    op: FederatedOp,
    body: Extract<PresenceBody, { kind: 'resolve' }>,
    ctx: StageContext
  ): 'applied' | 'dropped' {
    const by = ctx.view.members.get(op.replica);
    if (by?.role !== 'admin' || by.observer) {
      this.deps.fed.problem(
        `run-conflict:${String(body.run)}`,
        `${this.deps.roster.label(op.replica)} tried to resolve run ${String(body.run)}, but is no admin; ignored`
      );
      return 'dropped';
    }
    const bound = this.row(body.run);
    if (bound?.replica === body.replica) {
      this.settleClaims(body.run);
      return 'applied';
    }
    const claim =
      this.claimsOf(body.run)?.[body.replica] ??
      this.rivalClaim(body.run, body.replica);
    if (claim === undefined || claim === null) return 'dropped';
    this.bindResolved(body.run, body.replica, claim);
    return 'applied';
  }

  private bindResolved(run: string, replica: string, claim: Claim): void {
    const { fed, roster } = this.deps;
    // A run of this machine's resolved to another: say so; its mail no
    // longer goes out as the run (MailOut checks the binding).
    const was = this.row(run)?.replica ?? null;
    if (
      replica !== fed.replica &&
      (was === fed.replica || this.deps.knowsRun(run))
    )
      fed.problem(
        `run-moved:${run}`,
        `run ${run} was resolved to ${roster.label(replica)}'s machine; its messages from this machine no longer reach the team`
      );
    fed.db
      .query(
        'INSERT OR REPLACE INTO fed_runs (run, replica, task, run_kind, live, waiting_on, hlc) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        run,
        replica,
        claim.body.task,
        claim.body.runKind,
        claim.body.live ? 1 : 0,
        claim.body.waitingOn ?? null,
        claim.hlc
      );
    this.settleClaims(run);
    if (
      claim.body.live &&
      claim.body.runKind === 'execute' &&
      claim.body.task !== null
    )
      this.deps.onLiveRun?.(claim.body.task, replica, claim.hlc);
  }

  private bodyOf(row: RunRow): RunBody {
    return {
      kind: 'run',
      run: row.run,
      task: row.task,
      runKind: row.run_kind,
      live: row.live === 1,
      ...(row.waiting_on === null ? {} : { waitingOn: row.waiting_on }),
    };
  }

  private settleClaims(run: string): void {
    const { fed } = this.deps;
    fed.db.query('DELETE FROM fed_run_conflicts WHERE run = ?').run(run);
    fed.db.query('DELETE FROM fed_run_claims WHERE run = ?').run(run);
    fed.clearProblem(`run-conflict:${run}`);
  }

  // Claims refused because the run was already bound here, by claimant.
  private rivalClaims(run: string): Record<string, Claim> {
    const row = this.deps.fed.db
      .query<{ claims_json: string }, [string]>(
        'SELECT claims_json FROM fed_run_claims WHERE run = ?'
      )
      .get(run);
    return row === null
      ? {}
      : (JSON.parse(row.claims_json) as Record<string, Claim>);
  }

  private rivalClaim(run: string, replica: string): Claim | null {
    return this.rivalClaims(run)[replica] ?? null;
  }

  // A contested run's claimants, each with its latest claim (null until that
  // claimant's own op is read here), or null when the run is not contested.
  private claimsOf(run: string): Record<string, Claim | null> | null {
    const row = this.deps.fed.db
      .query<{ replicas_json: string }, [string]>(
        'SELECT replicas_json FROM fed_run_conflicts WHERE run = ?'
      )
      .get(run);
    return row === null
      ? null
      : (JSON.parse(row.replicas_json) as Record<string, Claim | null>);
  }

  // FW-R31(3): the run-conflict note can be acknowledged.
  private conflict(run: string, message: string, replicas: string[]): void {
    this.deps.fed.problem(`run-conflict:${run}`, message);
    this.deps.fed.audit('run-conflict', `run:${run}`, { run, replicas });
  }

  private publishRun(
    meta: RunInfo,
    live: boolean,
    waitingOn: string | null
  ): void {
    if (!this.canPublish()) return;
    const { fed } = this.deps;
    const body: PresenceBody = {
      kind: 'run',
      run: meta.id,
      task: meta.taskId,
      runKind: meta.kind ?? 'execute',
      live,
      ...(waitingOn === null ? {} : { waitingOn }),
    };
    // The run's row is written with its op, so this machine's homes see the
    // run at once and its first message always takes a later tick.
    fed.append({
      type: 'presence',
      body,
      onStamp: (stamp) => {
        fed.db
          .query(
            'INSERT OR REPLACE INTO fed_runs (run, replica, task, run_kind, live, waiting_on, hlc) VALUES (?, ?, ?, ?, ?, ?, ?)'
          )
          .run(
            meta.id,
            fed.replica,
            meta.taskId,
            body.runKind,
            live ? 1 : 0,
            waitingOn,
            stamp.hlc
          );
      },
    });
    this.deps.changed?.();
  }

  // Presence goes out only once this machine is admitted under a firm pin
  // (FW-R31(4)); a pending replica's chain stays its key op then its first
  // roster op, all a reader reads of it (FW-R26(4)).
  private canPublish(): boolean {
    return this.deps.fed.head() !== null && this.deps.roster.mailReady();
  }

  private row(run: string): RunRow | null {
    return this.deps.fed.db
      .query<RunRow, [string]>('SELECT * FROM fed_runs WHERE run = ?')
      .get(run);
  }
}

// Keeps each run's waitingOn current from the engine: a run's open blocking
// question to a human waits on that human, its answer ends the wait.
export function trackWaiting(
  engine: DeliveryEngine,
  messages: MessageStore,
  presence: Presence
): void {
  engine.subscribe((e) => {
    if (e.type !== 'message') return;
    const m = e.message;
    if (m.from.startsWith('run:') && m.blocking && m.kind === 'question') {
      const human = m.to.find((a) => a.startsWith('human:'));
      if (human !== undefined)
        presence.waitingOn(
          m.from.slice('run:'.length),
          human.slice('human:'.length)
        );
      return;
    }
    if (m.kind !== 'answer' || m.replyTo === null) return;
    const q = messages.getMessage(m.replyTo);
    if (q?.from.startsWith('run:') === true)
      presence.waitingOn(q.from.slice('run:'.length), null);
  });
}
