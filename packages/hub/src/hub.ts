import { queryAll, queryOne, tasksConflict } from '@dispatch-foo/core';
import type { SqliteDatabase, SqlValue } from '@dispatch-foo/core';
import { randomBytes } from 'node:crypto';

import type {
  Ack,
  ClaimHolder,
  ClaimRecord,
  Command,
  EventBody,
  FieldState,
  HubEvent,
  JsonValue,
  Origin,
  Refusal,
  SessionBeat,
  SessionRecord,
  SessionState,
  Snapshot,
  TaskSnapshot,
} from './types.js';

/** A session with no beat for this long is stalled. */
export const STALL_MS = 2 * 60 * 1000;
/** A stalled session's claims are held this long, then released. */
export const CLAIM_GRACE_MS = 15 * 60 * 1000;
/** The actor on events the hub raises itself (beats and sweeps). */
export const HUB_ACTOR = 'system:hub';

export interface TeamHubOptions {
  now?: () => number;
  stallMs?: number;
  claimGraceMs?: number;
  /** The id a created task gets when the one it asked for is taken. */
  mintId?: (taken: string) => string;
}

interface FieldRow {
  field: string;
  value: string;
  rev: number;
  actor: string;
}

interface SessionRow {
  machine: string;
  id: string;
  kind: SessionRecord['kind'];
  actor: string;
  project: string | null;
  branch: string | null;
  task: string | null;
  state: SessionState;
  waiting_on: string | null;
  label: string | null;
  beat: number;
  stalled_at: number | null;
}

interface ClaimRow {
  project: string;
  task: string;
  machine: string;
  session: string;
  actor: string;
  writes: string;
  since: string;
  seq: number;
}

interface EventRow {
  seq: number;
  at: string;
  actor: string;
  machine: string;
  cid: string | null;
  body: string;
}

// The same prefix with fresh random hex, so a renamed task still reads as a
// task (`t-…`) or a container (`e-…`).
function defaultMintId(taken: string): string {
  const dash = taken.indexOf('-');
  const prefix = dash > 0 ? taken.slice(0, dash) : 't';
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

function sessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    machine: row.machine,
    kind: row.kind,
    actor: row.actor,
    project: row.project,
    branch: row.branch,
    task: row.task,
    state: row.state,
    waitingOn: row.waiting_on,
    label: row.label,
    beat: new Date(row.beat).toISOString(),
  };
}

function claimRecord(row: ClaimRow): ClaimRecord {
  return {
    project: row.project,
    task: row.task,
    session: row.session,
    machine: row.machine,
    actor: row.actor,
    writes: JSON.parse(row.writes) as string[],
    since: row.since,
  };
}

function holder(row: ClaimRow, paths?: string[]): ClaimHolder {
  return {
    task: row.task,
    session: row.session,
    machine: row.machine,
    actor: row.actor,
    since: row.since,
    ...(paths === undefined ? {} : { paths }),
  };
}

// What a beat can change about a session, for deciding whether the change is
// worth an event. The beat time itself is not: it moves every 30 seconds.
function sameSession(row: SessionRow, beat: SessionBeat): boolean {
  return (
    row.kind === beat.kind &&
    row.actor === beat.actor &&
    row.project === beat.project &&
    row.branch === beat.branch &&
    row.task === beat.task &&
    row.state === beat.state &&
    row.waiting_on === beat.waitingOn &&
    row.label === beat.label
  );
}

/**
 * One team's authority. Every change goes through `apply` (a command from an
 * edge), `beat` (a machine reporting its live sessions) or `sweep` (the clock
 * noticing a silent one); each runs in one transaction, takes the next
 * sequence numbers and tells every subscriber once it has committed. There is
 * one order, so two machines never disagree about who claimed a task or which
 * edit came last.
 *
 * It knows nothing about sockets: a transport calls these methods and forwards
 * the events.
 */
export class TeamHub {
  private readonly now: () => number;
  private readonly stallMs: number;
  private readonly claimGraceMs: number;
  private readonly mintId: (taken: string) => string;
  private readonly listeners = new Set<(event: HubEvent) => void>();
  // Events of the open transaction, published only once it commits.
  private pending: HubEvent[] = [];

  constructor(
    private readonly db: SqliteDatabase,
    options: TeamHubOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.stallMs = options.stallMs ?? STALL_MS;
    this.claimGraceMs = options.claimGraceMs ?? CLAIM_GRACE_MS;
    this.mintId = options.mintId ?? defaultMintId;
  }

  /** Calls `listener` with every event after it commits; returns the undo. */
  subscribe(listener: (event: HubEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The seq of the latest event, 0 for an empty log. */
  head(): number {
    const row = queryOne<{ seq: number | null }>(
      this.db,
      'SELECT MAX(seq) AS seq FROM events'
    );
    return row?.seq ?? 0;
  }

  /**
   * Applies one command and answers it. A command the hub has already
   * answered gets the same answer again and changes nothing, so an edge that
   * lost the ack can resend its whole outbox.
   */
  apply(origin: Origin, command: Command): Ack {
    return this.transact(() => {
      const seen = queryOne<{ ack: string }>(
        this.db,
        'SELECT ack FROM commands WHERE cid = ?',
        [command.cid]
      );
      if (seen !== undefined) return JSON.parse(seen.ack) as Ack;
      const ack = this.run(origin, command);
      this.db
        .prepare('INSERT INTO commands (cid, ack) VALUES (?, ?)')
        .run(command.cid, JSON.stringify(ack));
      return ack;
    });
  }

  /**
   * A machine's report of the sessions it is running. Sessions it lists are
   * live as of now; sessions it used to list and no longer does have ended,
   * and their claims are released at once.
   */
  beat(machine: string, sessions: SessionBeat[]): void {
    this.transact(() => {
      const at = this.now();
      const listed = new Set<string>();
      for (const beat of sessions) {
        listed.add(beat.id);
        const row = this.session(machine, beat.id);
        this.db
          .prepare(
            `INSERT INTO sessions
               (machine, id, kind, actor, project, branch, task, state,
                waiting_on, label, beat, stalled_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
             ON CONFLICT (machine, id) DO UPDATE SET
               kind = excluded.kind, actor = excluded.actor,
               project = excluded.project, branch = excluded.branch,
               task = excluded.task, state = excluded.state,
               waiting_on = excluded.waiting_on, label = excluded.label,
               beat = excluded.beat, stalled_at = NULL`
          )
          .run(
            machine,
            beat.id,
            beat.kind,
            beat.actor,
            beat.project,
            beat.branch,
            beat.task,
            beat.state,
            beat.waitingOn,
            beat.label,
            at
          );
        if (row === undefined || !sameSession(row, beat))
          this.sessionChanged(machine, beat.id);
      }
      const gone = queryAll<SessionRow>(
        this.db,
        "SELECT * FROM sessions WHERE machine = ? AND state != 'ended'",
        [machine]
      ).filter((row) => !listed.has(row.id));
      for (const row of gone) {
        this.setState(row, 'ended', null);
        this.releaseClaimsOf(row, 'ended');
      }
    });
  }

  /**
   * The clock's pass: a live session nobody has heard from for `stallMs`
   * becomes stalled, and a session stalled for `claimGraceMs` loses its
   * claims. The run itself is never touched; its operator decides.
   */
  sweep(): void {
    this.transact(() => {
      const at = this.now();
      const silent = queryAll<SessionRow>(
        this.db,
        `SELECT * FROM sessions
         WHERE state IN ('working', 'waiting', 'idle') AND beat < ?`,
        [at - this.stallMs]
      );
      for (const row of silent) this.setState(row, 'stalled', at);
      const expired = queryAll<SessionRow>(
        this.db,
        "SELECT * FROM sessions WHERE state = 'stalled' AND stalled_at <= ?",
        [at - this.claimGraceMs]
      );
      for (const row of expired) this.releaseClaimsOf(row, 'expired');
    });
  }

  /** Up to `limit` events after `cursor`, in order, and whether more follow. */
  eventsAfter(
    cursor: number,
    limit = 500
  ): { events: HubEvent[]; more: boolean } {
    const rows = queryAll<EventRow>(
      this.db,
      'SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?',
      [cursor, limit + 1]
    );
    return {
      events: rows.slice(0, limit).map((row) => ({
        ...(JSON.parse(row.body) as EventBody),
        seq: row.seq,
        at: row.at,
        actor: row.actor,
        machine: row.machine,
        ...(row.cid === null ? {} : { cid: row.cid }),
      })),
      more: rows.length > limit,
    };
  }

  /** The whole state as of `seq`, for an edge that starts from nothing. */
  snapshot(): Snapshot {
    return this.transact(() => {
      const tasks = new Map<string, TaskSnapshot>();
      const live = queryAll<{ project: string; id: string }>(
        this.db,
        'SELECT project, id FROM tasks WHERE removed = 0 ORDER BY project, id'
      );
      for (const { project, id } of live)
        tasks.set(`${project}\n${id}`, {
          project,
          id,
          fields: {},
          entries: [],
        });
      const fields = queryAll<FieldRow & { project: string; task: string }>(
        this.db,
        'SELECT * FROM fields'
      );
      for (const row of fields) {
        const task = tasks.get(`${row.project}\n${row.task}`);
        if (task !== undefined)
          task.fields[row.field] = {
            value: JSON.parse(row.value) as JsonValue,
            rev: row.rev,
            actor: row.actor,
          };
      }
      const entries = queryAll<{
        seq: number;
        project: string;
        task: string;
        kind: string;
        entry: string;
      }>(this.db, 'SELECT * FROM entries ORDER BY seq');
      for (const row of entries)
        tasks.get(`${row.project}\n${row.task}`)?.entries.push({
          seq: row.seq,
          kind: row.kind,
          entry: JSON.parse(row.entry) as JsonValue,
        });
      return {
        seq: this.head(),
        tasks: [...tasks.values()],
        sessions: queryAll<SessionRow>(
          this.db,
          "SELECT * FROM sessions WHERE state != 'ended' ORDER BY machine, id"
        ).map(sessionRecord),
        claims: queryAll<ClaimRow>(
          this.db,
          'SELECT * FROM claims ORDER BY project, task'
        ).map(claimRecord),
      };
    });
  }

  private run(origin: Origin, command: Command): Ack {
    const refuse = (refusal: Refusal): Ack => ({
      cid: command.cid,
      ok: false,
      ...refusal,
    });
    switch (command.type) {
      case 'task.create':
        return this.create(origin, command);
      case 'task.set':
        if (!this.taskExists(command.project, command.id))
          return refuse({ why: 'unknown-task' });
        return this.set(origin, command);
      case 'task.append': {
        if (!this.taskExists(command.project, command.id))
          return refuse({ why: 'unknown-task' });
        const seq = this.emit(origin, command.cid, {
          type: 'task.appended',
          project: command.project,
          id: command.id,
          kind: command.kind,
          entry: command.entry,
        });
        this.db
          .prepare(
            'INSERT INTO entries (seq, project, task, kind, entry) VALUES (?, ?, ?, ?, ?)'
          )
          .run(
            seq,
            command.project,
            command.id,
            command.kind,
            JSON.stringify(command.entry)
          );
        return { cid: command.cid, ok: true, seq };
      }
      case 'task.remove':
        if (!this.taskExists(command.project, command.id))
          return refuse({ why: 'unknown-task' });
        return this.remove(origin, command);
      case 'claim':
        return this.claim(origin, command, refuse);
      case 'release': {
        const row = this.claimOn(command.project, command.task);
        if (
          row === undefined ||
          row.machine !== origin.machine ||
          row.session !== command.session
        )
          return refuse({ why: 'not-holder' });
        const seq = this.releaseClaim(row, 'released', origin, command.cid);
        return { cid: command.cid, ok: true, seq };
      }
    }
  }

  // Creates never fail: ids are minted on the edge, possibly offline, so a
  // taken id gets a fresh one and the ack says which.
  private create(
    origin: Origin,
    command: Extract<Command, { type: 'task.create' }>
  ): Ack {
    let id = command.id;
    while (this.taskKnown(command.project, id)) id = this.mintId(command.id);
    this.db
      .prepare('INSERT INTO tasks (project, id) VALUES (?, ?)')
      .run(command.project, id);
    const seq = this.emit(origin, command.cid, {
      type: 'task.created',
      project: command.project,
      id,
      fields: command.fields,
    });
    for (const [field, value] of Object.entries(command.fields))
      this.writeField(command.project, id, field, value, seq, origin.actor);
    return {
      cid: command.cid,
      ok: true,
      seq,
      ...(id === command.id ? {} : { renamed: id }),
    };
  }

  // Decides a set field by field: a field is applied when nobody has set it
  // since the rev the edge last saw (`base`), and reported back as stale
  // otherwise. Fields that already hold the value asked for are left alone.
  private set(
    origin: Origin,
    command: Extract<Command, { type: 'task.set' }>
  ): Ack {
    const current = this.fieldsOf(command.project, command.id);
    const fresh: Record<string, JsonValue> = {};
    const stale: Record<string, FieldState> = {};
    for (const [field, value] of Object.entries(command.fields)) {
      const held = current.get(field);
      const base = command.base?.[field];
      if (held !== undefined && base !== undefined && held.rev > base) {
        stale[field] = held;
        continue;
      }
      if (
        held === undefined ||
        JSON.stringify(held.value) !== JSON.stringify(value)
      )
        fresh[field] = value;
    }
    const anyStale = Object.keys(stale).length > 0;
    if (Object.keys(fresh).length === 0) {
      if (anyStale) return { cid: command.cid, ok: false, why: 'stale', stale };
      return { cid: command.cid, ok: true, seq: this.head() };
    }
    const seq = this.emit(origin, command.cid, {
      type: 'task.changed',
      project: command.project,
      id: command.id,
      fields: fresh,
    });
    for (const [field, value] of Object.entries(fresh))
      this.writeField(
        command.project,
        command.id,
        field,
        value,
        seq,
        origin.actor
      );
    return {
      cid: command.cid,
      ok: true,
      seq,
      ...(anyStale ? { stale } : {}),
    };
  }

  // Removing a task keeps its row as a tombstone, so a later write from an
  // edge that was offline is refused instead of bringing the task back.
  private remove(
    origin: Origin,
    command: Extract<Command, { type: 'task.remove' }>
  ): Ack {
    const key: SqlValue[] = [command.project, command.id];
    this.db
      .prepare('UPDATE tasks SET removed = 1 WHERE project = ? AND id = ?')
      .run(...key);
    this.db
      .prepare('DELETE FROM fields WHERE project = ? AND task = ?')
      .run(...key);
    this.db
      .prepare('DELETE FROM entries WHERE project = ? AND task = ?')
      .run(...key);
    const seq = this.emit(origin, command.cid, {
      type: 'task.removed',
      project: command.project,
      id: command.id,
    });
    const claim = this.claimOn(command.project, command.id);
    if (claim !== undefined) this.releaseClaim(claim, 'removed');
    return { cid: command.cid, ok: true, seq };
  }

  // Admits a claim when nobody else holds the task and no other claim in the
  // project declares overlapping paths. A claim with no declared paths holds
  // only its task: it neither blocks nor is blocked by paths.
  private claim(
    origin: Origin,
    command: Extract<Command, { type: 'claim' }>,
    refuse: (refusal: Refusal) => Ack
  ): Ack {
    if (!this.taskExists(command.project, command.task))
      return refuse({ why: 'unknown-task' });
    const session = this.session(origin.machine, command.session);
    if (session === undefined || session.state === 'ended')
      return refuse({ why: 'unknown-session' });
    const existing = this.claimOn(command.project, command.task);
    const mine =
      existing !== undefined &&
      existing.machine === origin.machine &&
      existing.session === command.session;
    if (existing !== undefined && !mine)
      return refuse({ why: 'held', holder: holder(existing) });
    if (command.writes.length > 0) {
      const others = queryAll<ClaimRow>(
        this.db,
        'SELECT * FROM claims WHERE project = ? AND task != ?',
        [command.project, command.task]
      );
      for (const other of others) {
        const theirs = JSON.parse(other.writes) as string[];
        if (theirs.length === 0) continue;
        const paths = command.writes.filter((path) =>
          tasksConflict([path], theirs)
        );
        if (paths.length > 0)
          return refuse({ why: 'overlap', holder: holder(other, paths) });
      }
    }
    const writes = JSON.stringify(command.writes);
    if (mine && existing.writes === writes)
      return { cid: command.cid, ok: true, seq: existing.seq };
    const since = mine ? existing.since : new Date(this.now()).toISOString();
    const seq = this.emit(origin, command.cid, {
      type: 'claim.granted',
      claim: {
        project: command.project,
        task: command.task,
        session: command.session,
        machine: origin.machine,
        actor: session.actor,
        writes: command.writes,
        since,
      },
    });
    this.db
      .prepare(
        `INSERT INTO claims (project, task, machine, session, actor, writes, since, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project, task) DO UPDATE SET
           writes = excluded.writes, seq = excluded.seq`
      )
      .run(
        command.project,
        command.task,
        origin.machine,
        command.session,
        session.actor,
        writes,
        since,
        seq
      );
    return { cid: command.cid, ok: true, seq };
  }

  private releaseClaim(
    row: ClaimRow,
    reason: 'released' | 'ended' | 'expired' | 'removed',
    origin: Origin = { actor: HUB_ACTOR, machine: row.machine },
    cid?: string
  ): number {
    this.db
      .prepare('DELETE FROM claims WHERE project = ? AND task = ?')
      .run(row.project, row.task);
    return this.emit(origin, cid, {
      type: 'claim.released',
      project: row.project,
      task: row.task,
      session: row.session,
      machine: row.machine,
      reason,
    });
  }

  private releaseClaimsOf(
    session: SessionRow,
    reason: 'ended' | 'expired'
  ): void {
    const held = queryAll<ClaimRow>(
      this.db,
      'SELECT * FROM claims WHERE machine = ? AND session = ?',
      [session.machine, session.id]
    );
    for (const row of held) this.releaseClaim(row, reason);
  }

  private setState(
    row: SessionRow,
    state: SessionState,
    stalledAt: number | null
  ): void {
    this.db
      .prepare(
        'UPDATE sessions SET state = ?, stalled_at = ? WHERE machine = ? AND id = ?'
      )
      .run(state, stalledAt, row.machine, row.id);
    this.sessionChanged(row.machine, row.id);
  }

  private sessionChanged(machine: string, id: string): void {
    const row = this.session(machine, id);
    if (row === undefined) return;
    this.emit({ actor: HUB_ACTOR, machine }, undefined, {
      type: 'session.changed',
      session: sessionRecord(row),
    });
  }

  private session(machine: string, id: string): SessionRow | undefined {
    return queryOne<SessionRow>(
      this.db,
      'SELECT * FROM sessions WHERE machine = ? AND id = ?',
      [machine, id]
    );
  }

  private claimOn(project: string, task: string): ClaimRow | undefined {
    return queryOne<ClaimRow>(
      this.db,
      'SELECT * FROM claims WHERE project = ? AND task = ?',
      [project, task]
    );
  }

  /** Whether the id was ever used in the project, removed tasks included. */
  private taskKnown(project: string, id: string): boolean {
    return (
      queryOne(this.db, 'SELECT 1 FROM tasks WHERE project = ? AND id = ?', [
        project,
        id,
      ]) !== undefined
    );
  }

  private taskExists(project: string, id: string): boolean {
    return (
      queryOne(
        this.db,
        'SELECT 1 FROM tasks WHERE project = ? AND id = ? AND removed = 0',
        [project, id]
      ) !== undefined
    );
  }

  private fieldsOf(project: string, task: string): Map<string, FieldState> {
    const rows = queryAll<FieldRow>(
      this.db,
      'SELECT field, value, rev, actor FROM fields WHERE project = ? AND task = ?',
      [project, task]
    );
    return new Map(
      rows.map((row) => [
        row.field,
        {
          value: JSON.parse(row.value) as JsonValue,
          rev: row.rev,
          actor: row.actor,
        },
      ])
    );
  }

  private writeField(
    project: string,
    task: string,
    field: string,
    value: JsonValue,
    rev: number,
    actor: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO fields (project, task, field, value, rev, actor)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (project, task, field) DO UPDATE SET
           value = excluded.value, rev = excluded.rev, actor = excluded.actor`
      )
      .run(project, task, field, JSON.stringify(value), rev, actor);
  }

  // Appends one event to the log and returns its seq. The event reaches
  // subscribers only when the surrounding transaction commits.
  private emit(
    origin: Origin,
    cid: string | undefined,
    body: EventBody
  ): number {
    const at = new Date(this.now()).toISOString();
    const { lastInsertRowid } = this.db
      .prepare(
        'INSERT INTO events (at, actor, machine, cid, body) VALUES (?, ?, ?, ?, ?)'
      )
      .run(at, origin.actor, origin.machine, cid ?? null, JSON.stringify(body));
    const seq = Number(lastInsertRowid);
    this.pending.push({
      ...body,
      seq,
      at,
      actor: origin.actor,
      machine: origin.machine,
      ...(cid === undefined ? {} : { cid }),
    });
    return seq;
  }

  // Runs `fn` as one write transaction: all of its changes and events land,
  // or none do. Subscribers hear the events only after the commit, in order.
  private transact<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    let result: T;
    try {
      result = fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.pending = [];
      this.db.exec('ROLLBACK');
      throw err;
    }
    const events = this.pending;
    this.pending = [];
    for (const event of events)
      for (const listener of this.listeners) listener(event);
    return result;
  }
}
