import { hlcWallMs } from '@dispatch/protocol/federation';
import type { FederatedOp, PresenceBody } from '@dispatch/protocol/federation';

import type { RosterService } from './roster.js';
import type { Collector, OpHandler, StageContext } from './service.js';
import type { FedStore } from './store.js';

const PRESENCE_REPLICA_EVERY_MS = 60 * 60 * 1000;
const ENDED_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** What the orchestrator says about a run that started or ended. */
export interface RunInfo {
  id: string;
  taskId: string | null;
  kind?: string;
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
    private readonly deps: {
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
      if ((hlcWallMs(row.hlc) ?? 0) < cutoff)
        fed.db.query('DELETE FROM fed_runs WHERE run = ?').run(row.run);
  }

  stage(op: FederatedOp, ctx: StageContext): 'applied' | 'parked' | 'dropped' {
    const body = op.body as PresenceBody | undefined;
    if (body?.kind === 'replica') {
      this.deps.fed.db
        .query(
          'INSERT OR REPLACE INTO fed_replicas (replica, build, device, last_hlc, skew_ms) VALUES (?, ?, ?, ?, ?)'
        )
        .run(
          op.replica,
          String(body.build),
          String(body.device),
          op.hlc,
          Number(body.wall) - ctx.now.getTime()
        );
      return 'applied';
    }
    if (body?.kind !== 'run' || typeof body.run !== 'string') return 'dropped';
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
    if (bound !== null && bound.replica !== p) holder = bound.replica;
    else if (bound === null && this.deps.knowsRun(body.run))
      holder = fed.replica;
    if (holder !== null) {
      this.conflict(
        body.run,
        `${roster.label(p)} claims run ${body.run}, already running on ${roster.label(holder)}`,
        [p, holder]
      );
      return 'dropped';
    }
    if (bound === null && this.contested(body.run, claims, ctx))
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
  private contested(run: string, claims: string[], ctx: StageContext): boolean {
    const { fed, roster } = this.deps;
    const held = fed.db
      .query<{ replicas_json: string }, [string]>(
        'SELECT replicas_json FROM fed_run_conflicts WHERE run = ?'
      )
      .get(run);
    const all = [
      ...new Set([
        ...(held === null ? [] : (JSON.parse(held.replicas_json) as string[])),
        ...claims,
      ]),
    ].sort();
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
      .run(run, JSON.stringify(all));
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
