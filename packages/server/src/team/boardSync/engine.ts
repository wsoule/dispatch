import type { TaskDoc, TaskMeta } from '@dispatch/core';
import { newTaskDoc } from '@dispatch/core';

// The merge half of board sync: what a change to a task looks like on the
// wire, and how a replica folds someone else's changes into its own board.
// Transport — the git repository the changes travel through, and when — is
// packages/server/src/sync; nothing here touches a file or a network.
//
// The model is state-based and per field. A change carries the new value of
// every field it touched, stamped with a hybrid logical clock; a replica takes
// a field's value from whichever change carries the later clock, and keeps the
// clock it took it from. Applying the same changes in any order, any number of
// times, lands every replica on the same board — which is the whole point, as
// changes arrive from several machines, late, and more than once.
//
// Two parts of a task do not fit "last writer wins":
// - Activity is a log. Both people's lines must survive, so each change
//   carries only the lines it added, and the section is rebuilt from every
//   line ever seen in clock order — the same order on every machine.
// - A deletion must not be undone by an edit made before it, nor erase an
//   edit made after it. A removal leaves a tombstone clock; changes older
//   than it are ignored, and a task survives a removal only if something
//   touched it later.

/** One change to one task, as it travels between replicas. */
export interface BoardOp {
  v: 1;
  /** Which replica made it. Also the file it travels in. */
  replica: string;
  /** Its position in that replica's own log, from 1. */
  seq: number;
  /** When, on the hybrid logical clock. Orders every change on every replica. */
  hlc: string;
  task: string;
  kind: 'put' | 'remove';
  /** On a task's first change only: its `created` time. Two replicas that
   *  mint the same id for different tasks disagree here, which is how a
   *  clash is told apart from two views of one task. */
  origin?: string;
  /** The new value of each field this change touched. */
  fields?: Record<string, unknown>;
  /** Lines this change appended to the task's Activity section. */
  activity?: string[];
}

/** A field's value as this replica holds it, and the clock it came with. */
export interface HeldField {
  hlc: string;
  value: unknown;
}

/**
 * What a replica remembers about how its board got the way it is. Kept by the
 * caller (a table in the daemon, a map in a test); the functions here only
 * ever read and write it through this.
 *
 * It holds every synced field's value, not only its clock, and a task is
 * always rebuilt from it. That is what lets a deleted task come back whole
 * when a later edit revives it, and a change that arrives before the creation
 * it follows land on the same task every other replica has: the replica's own
 * copy of the task may be gone or not there yet, but its fields are here.
 */
export interface MergeState {
  field(task: string, field: string): HeldField | undefined;
  setField(task: string, field: string, hlc: string, value: unknown): void;
  fields(task: string): Record<string, HeldField>;
  tombstone(task: string): string | undefined;
  setTombstone(task: string, hlc: string): void;
  origin(task: string): string | undefined;
  setOrigin(task: string, origin: string): void;
  /** Idempotent on (hlc, index): the same line from the same change twice is
   *  one line. */
  addActivity(task: string, hlc: string, index: number, line: string): void;
  /** Every Activity line ever seen for the task, in clock order. */
  activity(task: string): string[];
}

// ---------------------------------------------------------------------------
// The hybrid logical clock.

/**
 * A clock that orders changes across machines whose wall clocks disagree.
 *
 * Each reading is `<ms>.<counter>.<replica>`, zero-padded so plain string
 * comparison is clock order. It never goes backwards: a reading is at least
 * the wall clock, and at least one past anything this replica has seen from
 * anyone else — so a change made after reading someone's change always sorts
 * after it, however far behind this machine's clock is. The replica id breaks
 * the one remaining tie, two readings in the same millisecond and counter.
 */
export class HybridClock {
  private ms: number;
  private counter: number;

  constructor(
    private readonly replica: string,
    last: string | null = null,
    private readonly now: () => number = Date.now
  ) {
    const parsed = last === null ? null : parseHlc(last);
    this.ms = parsed?.ms ?? 0;
    this.counter = parsed?.counter ?? 0;
  }

  /** A reading for a change made now. */
  tick(): string {
    const wall = this.now();
    if (wall > this.ms) {
      this.ms = wall;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
    return formatHlc(this.ms, this.counter, this.replica);
  }

  /** Moves past a reading from elsewhere, so the next tick sorts after it. */
  observe(remote: string): void {
    const parsed = parseHlc(remote);
    if (parsed === null) return;
    if (
      parsed.ms > this.ms ||
      (parsed.ms === this.ms && parsed.counter > this.counter)
    ) {
      this.ms = parsed.ms;
      this.counter = parsed.counter;
    }
  }

  /** The latest reading, for persisting across restarts. */
  get last(): string {
    return formatHlc(this.ms, this.counter, this.replica);
  }
}

function formatHlc(ms: number, counter: number, replica: string): string {
  return `${String(ms).padStart(13, '0')}.${String(counter).padStart(4, '0')}.${replica}`;
}

function parseHlc(hlc: string): { ms: number; counter: number } | null {
  const match = /^(\d{13})\.(\d{4,})\./.exec(hlc);
  if (match === null) return null;
  return { ms: Number(match[1]), counter: Number(match[2]) };
}

/** The wall-clock time a reading was taken at, as an ISO string. */
function hlcTime(hlc: string): string | null {
  const parsed = parseHlc(hlc);
  return parsed === null ? null : new Date(parsed.ms).toISOString();
}

// ---------------------------------------------------------------------------
// A task as fields.

// Every meta field that travels. `id` is the key itself and `updated` is
// derived on each replica from the newest clock it holds for the task, so
// every replica computes the same one instead of keeping whoever wrote last.
const META_FIELDS = [
  'title',
  'status',
  'kind',
  'parent',
  'milestone',
  'blockedBy',
  'labels',
  'priority',
  'assignee',
  'created',
  'external',
  'selfReview',
  'writes',
  'fixLoop',
  'risk',
  'model',
  'archivedAt',
  'exercised',
  'derivedFrom',
  'attachments',
] as const satisfies readonly (keyof TaskMeta)[];

// Optional in TaskMeta: travels as null when absent, so clearing one (an
// unarchive) is a change like any other rather than a missing key.
const OPTIONAL_META = new Set<string>([
  'fixLoop',
  'archivedAt',
  'derivedFrom',
  'attachments',
]);

const ACTIVITY = 'Activity';
const PREAMBLE = '§preamble';
const ORDER = '§order';
const SECTION = '§h:';

interface BodyParts {
  preamble: string;
  sections: { heading: string; content: string }[];
}

// The same split taskfile.ts uses: a section runs from its `## ` line to the
// next. Content keeps its own surrounding newlines, so joining the parts back
// gives the body byte for byte.
export function splitBody(body: string): BodyParts {
  const parts = body.split(/^(## .+)$/m);
  const sections: BodyParts['sections'] = [];
  for (let i = 1; i < parts.length; i += 2) {
    sections.push({
      heading: parts[i].replace(/^## /, '').trim(),
      content: parts[i + 1] ?? '',
    });
  }
  return { preamble: parts[0], sections };
}

function activityLines(content: string): string[] {
  return content.split('\n').filter((line) => line.trim() !== '');
}

/** A task as the fields that travel, plus its Activity lines. */
export function taskFields(doc: TaskDoc): {
  fields: Record<string, unknown>;
  activity: string[];
} {
  const fields: Record<string, unknown> = {};
  for (const key of META_FIELDS) {
    fields[key] = (doc.meta as unknown as Record<string, unknown>)[key] ?? null;
  }
  const { preamble, sections } = splitBody(doc.body);
  fields[PREAMBLE] = preamble;
  fields[ORDER] = sections.map((s) => s.heading);
  let activity: string[] = [];
  for (const { heading, content } of sections) {
    if (heading === ACTIVITY) activity = activityLines(content);
    else fields[`${SECTION}${heading}`] = content;
  }
  return { fields, activity };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The change that turns `before` into `after`, or null when nothing that
 * travels changed. `before` null is a creation, and carries every field;
 * `after` null is a removal.
 */
export function diffTask(
  before: TaskDoc | null,
  after: TaskDoc | null
): Pick<BoardOp, 'kind' | 'fields' | 'activity' | 'origin'> | null {
  if (after === null) return before === null ? null : { kind: 'remove' };
  const next = taskFields(after);
  if (before === null) {
    return {
      kind: 'put',
      origin: after.meta.created,
      fields: next.fields,
      activity: next.activity,
    };
  }
  const prev = taskFields(before);
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next.fields)) {
    if (!same(prev.fields[key], value)) fields[key] = value;
  }
  // A section that went away is a change too: the order says so, and its
  // content key is cleared so a later re-add starts clean.
  for (const key of Object.keys(prev.fields)) {
    if (key.startsWith(SECTION) && !(key in next.fields)) fields[key] = null;
  }
  // Only lines past what was already there are new: Activity is appended to,
  // and a line that happens to repeat an earlier one is still a new line.
  const activity = next.activity.slice(prev.activity.length);
  if (Object.keys(fields).length === 0 && activity.length === 0) return null;
  return {
    kind: 'put',
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    ...(activity.length > 0 ? { activity } : {}),
  };
}

// ---------------------------------------------------------------------------
// Applying a change.

/** What applying a change did. `doc` null with `changed` means removed. */
export interface ApplyResult {
  changed: boolean;
  doc: TaskDoc | null;
  /** Set when the change could not be applied and a person needs to know. */
  problem?: string;
}

// The base a task is rebuilt on when this replica has never held it: the
// store's own defaults for a new task, so a field no change has reached yet
// reads exactly as it would on a task created here. Every creation carries
// every field, so this only shows through for a change that arrives before
// the creation it follows — and is overwritten when the creation lands.
function blankMeta(id: string): TaskMeta {
  const epoch = new Date(0).toISOString();
  return newTaskDoc(
    id,
    id.startsWith('e-') ? 'epic' : 'task',
    { title: '' },
    epoch
  ).meta;
}

// A synced field no task carries: the clock of the latest change of any kind
// to a task. A task exists while this is newer than its newest removal.
const TOUCH = '§touch';

/**
 * Whether the task exists, going by everything seen so far: something touched
 * it after the newest removal. Derived rather than stored, so it cannot
 * depend on the order changes arrived in.
 */
function present(state: MergeState, task: string): boolean {
  const touched = state.field(task, TOUCH)?.hlc;
  if (touched === undefined) return false;
  const tomb = state.tombstone(task);
  return tomb === undefined || touched > tomb;
}

/**
 * Folds one change into a task. `current` is the task as this replica holds
 * it (null when it has none); the result is what it should hold after.
 *
 * Every part of the state merges the same way whatever order changes come
 * in: a field keeps the value with the newest clock, the tombstone keeps the
 * newest removal, Activity keeps every line. The task itself is then rebuilt
 * from that state, so two replicas that have seen the same changes hold the
 * same task — which is the property the convergence tests check.
 */
export function applyOp(
  op: BoardOp,
  current: TaskDoc | null,
  state: MergeState
): ApplyResult {
  const unchanged: ApplyResult = { changed: false, doc: current };

  // Two different tasks under one id: refuse, and say so. Merging them would
  // be two people's work silently turned into one task neither wrote.
  if (op.kind === 'put' && op.origin !== undefined) {
    const known = state.origin(op.task);
    if (known === undefined) state.setOrigin(op.task, op.origin);
    else if (known !== op.origin) {
      return {
        ...unchanged,
        problem: `${op.task} was created separately on two machines (${known} and ${op.origin}); this one keeps its own, rename one to merge them`,
      };
    }
  }

  fold(op, state);

  if (!present(state, op.task)) {
    return current === null ? unchanged : { changed: true, doc: null };
  }
  const doc = assembleFromState(op.task, state);
  // Rewriting an unchanged task would bump nothing a person can see, but it
  // would cost a write and a board refresh per duplicate change.
  if (current !== null && same(taskFields(current), taskFields(doc))) {
    return unchanged;
  }
  return { changed: true, doc };
}

// Merges one change into the state, whoever made it.
function fold(op: BoardOp, state: MergeState): void {
  if (op.kind === 'remove') {
    const tomb = state.tombstone(op.task);
    if (tomb === undefined || op.hlc > tomb)
      state.setTombstone(op.task, op.hlc);
    return;
  }
  const keep = (key: string, value: unknown) => {
    const held = state.field(op.task, key);
    if (held === undefined || op.hlc > held.hlc) {
      state.setField(op.task, key, op.hlc, value);
    }
  };
  for (const [key, value] of Object.entries(op.fields ?? {})) keep(key, value);
  keep(TOUCH, null);
  (op.activity ?? []).forEach((line, index) =>
    state.addActivity(op.task, op.hlc, index, line)
  );
}

function newestClock(state: MergeState, task: string): string | undefined {
  let newest: string | undefined;
  for (const held of Object.values(state.fields(task))) {
    if (newest === undefined || held.hlc > newest) newest = held.hlc;
  }
  return newest;
}

/** The task exactly as this replica's state describes it — the same on every
 *  replica that has seen the same changes. */
function assembleFromState(id: string, state: MergeState): TaskDoc {
  const fields: Record<string, unknown> = {};
  for (const [key, held] of Object.entries(state.fields(id))) {
    fields[key] = held.value;
  }
  return assemble(id, fields, state.activity(id), state);
}

function assemble(
  id: string,
  fields: Record<string, unknown>,
  activity: string[],
  state: MergeState
): TaskDoc {
  const meta = blankMeta(id) as unknown as Record<string, unknown>;
  for (const key of META_FIELDS) {
    const value = fields[key];
    if (value === null || value === undefined) {
      if (OPTIONAL_META.has(key)) delete meta[key];
      else if (value === null) meta[key] = null;
    } else {
      meta[key] = value;
    }
  }
  const newest = newestClock(state, id);
  meta.updated =
    (newest === undefined ? null : hlcTime(newest)) ?? (meta.created as string);

  const order = Array.isArray(fields[ORDER]) ? (fields[ORDER] as string[]) : [];
  const headings = [
    ...order,
    ...Object.keys(fields)
      .filter((k) => k.startsWith(SECTION) && fields[k] !== null)
      .map((k) => k.slice(SECTION.length))
      .filter((h) => !order.includes(h)),
  ];
  let body = typeof fields[PREAMBLE] === 'string' ? fields[PREAMBLE] : '';
  for (const heading of headings) {
    if (heading === ACTIVITY) {
      // The shape appendActivity leaves: the heading, a newline, one line
      // per entry.
      body += `## ${ACTIVITY}\n${activity.map((l) => `${l}\n`).join('')}`;
      continue;
    }
    const content = fields[`${SECTION}${heading}`];
    if (typeof content !== 'string') continue;
    body += `## ${heading}${content}`;
  }
  if (!headings.includes(ACTIVITY) && activity.length > 0) {
    body += `${body.endsWith('\n') ? '' : '\n'}\n## ${ACTIVITY}\n${activity.map((l) => `${l}\n`).join('')}`;
  }
  return { meta: meta as unknown as TaskMeta, body };
}

/**
 * Records a change this replica made itself, as if it had arrived: its clocks,
 * its Activity lines, its origin. Without this the replica would not know its
 * own fields' clocks, and the first remote change to the task would rebuild it
 * without the local Activity lines.
 */
export function recordLocal(op: BoardOp, state: MergeState): void {
  if (
    op.kind === 'put' &&
    op.origin !== undefined &&
    state.origin(op.task) === undefined
  ) {
    state.setOrigin(op.task, op.origin);
  }
  fold(op, state);
}

/** A MergeState held in memory — for tests, and for anything short-lived. */
export function memoryMergeState(): MergeState {
  const held = new Map<string, Map<string, HeldField>>();
  const tombstones = new Map<string, string>();
  const origins = new Map<string, string>();
  const lines = new Map<
    string,
    Map<string, { hlc: string; index: number; line: string }>
  >();
  return {
    field: (task, field) => held.get(task)?.get(field),
    setField: (task, field, hlc, value) => {
      const forTask = held.get(task) ?? new Map<string, HeldField>();
      forTask.set(field, { hlc, value });
      held.set(task, forTask);
    },
    fields: (task) => Object.fromEntries(held.get(task) ?? []),
    tombstone: (task) => tombstones.get(task),
    setTombstone: (task, hlc) => void tombstones.set(task, hlc),
    origin: (task) => origins.get(task),
    setOrigin: (task, origin) => void origins.set(task, origin),
    addActivity: (task, hlc, index, line) => {
      const forTask = lines.get(task) ?? new Map();
      forTask.set(`${hlc}#${String(index).padStart(6, '0')}`, {
        hlc,
        index,
        line,
      });
      lines.set(task, forTask);
    },
    activity: (task) =>
      [...(lines.get(task)?.entries() ?? [])]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, v]) => v.line),
  };
}
