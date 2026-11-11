// The hub's vocabulary: what an edge sends (commands and beats), what the hub
// answers (acks) and what it tells everyone (events). Nothing here touches a
// database or a socket; docs/specs/2026-11-11-central-hub-design.md is the
// design these types implement.

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Who a command comes from: the person or agent, and the machine it ran on. */
export interface Origin {
  actor: string;
  machine: string;
}

interface CommandBase {
  /** The edge's id for this command; sending it again is applied once. */
  cid: string;
  project: string;
}

export type Command =
  | (CommandBase & {
      type: 'task.create';
      id: string;
      fields: Record<string, JsonValue>;
    })
  | (CommandBase & {
      type: 'task.set';
      id: string;
      fields: Record<string, JsonValue>;
      /** Per field, the rev the edge last saw. A field with none always wins. */
      base?: Record<string, number>;
    })
  | (CommandBase & {
      type: 'task.append';
      id: string;
      /** What is appended: a comment, an activity line, a finding. */
      kind: string;
      entry: JsonValue;
    })
  | (CommandBase & { type: 'task.remove'; id: string })
  | (CommandBase & {
      type: 'claim';
      task: string;
      session: string;
      writes: string[];
    })
  | (CommandBase & { type: 'release'; task: string; session: string });

/** A field as the hub holds it: its value and the seq that last set it. */
export interface FieldState {
  value: JsonValue;
  rev: number;
  actor: string;
}

/** Who holds a claim, as a refusal reports it. */
export interface ClaimHolder {
  task: string;
  session: string;
  machine: string;
  actor: string;
  since: string;
  /** For an overlap: the asker's paths that collide with this claim. */
  paths?: string[];
}

export type Refusal =
  | { why: 'stale'; stale: Record<string, FieldState> }
  | { why: 'held' | 'overlap'; holder: ClaimHolder }
  | { why: 'unknown-task' | 'unknown-session' | 'not-holder' };

export type Ack =
  | {
      cid: string;
      ok: true;
      /** The hub's sequence number once this command was applied. */
      seq: number;
      /** A created task's id, when the one asked for was taken. */
      renamed?: string;
      /** Fields of a `task.set` the hub did not apply, with what it holds. */
      stale?: Record<string, FieldState>;
    }
  | ({ cid: string; ok: false } & Refusal);

export type SessionKind = 'session' | 'run' | 'hosted' | 'overseer';
/** What an edge reports about a session it is running. */
export type LiveState = 'working' | 'waiting' | 'idle';
export type SessionState = LiveState | 'stalled' | 'ended';

/** One live session in a machine's beat. */
export interface SessionBeat {
  id: string;
  kind: SessionKind;
  actor: string;
  project: string | null;
  branch: string | null;
  task: string | null;
  state: LiveState;
  /** The gate a waiting session waits on. */
  waitingOn: string | null;
  label: string | null;
}

export interface SessionRecord extends Omit<SessionBeat, 'state'> {
  machine: string;
  state: SessionState;
  /** When the hub last heard from the session. */
  beat: string;
}

export interface ClaimRecord {
  project: string;
  task: string;
  session: string;
  machine: string;
  actor: string;
  writes: string[];
  since: string;
}

export type EventBody =
  | {
      type: 'task.created' | 'task.changed';
      project: string;
      id: string;
      fields: Record<string, JsonValue>;
    }
  | {
      type: 'task.appended';
      project: string;
      id: string;
      kind: string;
      entry: JsonValue;
    }
  | { type: 'task.removed'; project: string; id: string }
  | { type: 'claim.granted'; claim: ClaimRecord }
  | {
      type: 'claim.released';
      project: string;
      task: string;
      session: string;
      machine: string;
      reason: 'released' | 'ended' | 'expired' | 'removed';
    }
  | { type: 'session.changed'; session: SessionRecord };

/** One entry of the hub's log: the audit trail and the sync stream. */
export type HubEvent = EventBody & {
  seq: number;
  at: string;
  actor: string;
  machine: string;
  /** The command that caused it; absent for beats and sweeps. */
  cid?: string;
};

export interface TaskSnapshot {
  project: string;
  id: string;
  fields: Record<string, FieldState>;
  entries: { seq: number; kind: string; entry: JsonValue }[];
}

/** Everything an edge needs to start from nothing. */
export interface Snapshot {
  /** Events after this seq continue the snapshot. */
  seq: number;
  tasks: TaskSnapshot[];
  sessions: SessionRecord[];
  claims: ClaimRecord[];
}
