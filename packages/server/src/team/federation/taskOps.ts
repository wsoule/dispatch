import type { JsonValue } from '@dispatch-foo/protocol';
import { MAX_OP_BYTES } from '@dispatch-foo/protocol/federation';
import type { FederatedOp } from '@dispatch-foo/protocol/federation';

import type { BoardOp } from '../boardSync/engine.js';
import { recordLocal, splitBody } from '../boardSync/engine.js';
import type { SyncLedger } from '../boardSync/ledger.js';
import { ContentKeyMissingError } from './content.js';
import type { RosterService } from './roster.js';
import type { FedStore } from './store.js';

// A task write's field over this is refused before the write: no split can
// shrink one field, and an unpublishable op would wedge the chain behind it.
export const MAX_TASK_FIELD_BYTES = 896 * 1024;
/** Room for the header, signature and framing around a task op's body. */
export const OP_ENVELOPE_BYTES = 8 * 1024;
/** A task op's body budget once content is e2e: its ciphertext travels as
 *  base64url (4/3) beside the envelope's epoch, nonce and tag. */
const E2E_TASK_BODY_BYTES = Math.floor(
  ((MAX_OP_BYTES - OP_ENVELOPE_BYTES - 1024) * 3) / 4
);
/** The field cap once content is e2e, so one field still fits one op. */
const E2E_TASK_FIELD_BYTES = 640 * 1024;

export class TaskTooLargeError extends Error {
  override name = 'TaskTooLargeError';
  constructor(
    readonly field: string,
    readonly bytes: number,
    cap: number = MAX_TASK_FIELD_BYTES
  ) {
    super(
      `This task is too large to sync with your team: ${field} is ${Math.ceil(bytes / 1024)} KiB; the limit is ${cap / 1024} KiB. Split it, or move long text into a doc.`
    );
  }
}

export type TaskChange = Omit<BoardOp, 'v' | 'replica' | 'seq' | 'hlc'>;

const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

function over(
  field: string,
  value: unknown,
  cap: number
): { field: string; bytes: number } | null {
  const bytes = jsonBytes(value ?? null);
  return bytes > cap ? { field, bytes } : null;
}

// The first field a write would send over the cap (F-D36): each non-body field
// whole, and the body as taskFields sends it, so a long body of modest
// sections passes and is split into several ops instead.
export function oversizedField(
  input: Record<string, unknown>,
  cap: number = MAX_TASK_FIELD_BYTES
): { field: string; bytes: number } | null {
  for (const [key, value] of Object.entries(input)) {
    if (key === 'body') continue;
    const hit = over(key, value, cap);
    if (hit !== null) return hit;
  }
  const body = input.body;
  if (typeof body !== 'string') return null;
  const { preamble, sections } = splitBody(body);
  const first = over('body', preamble, cap);
  if (first !== null) return first;
  for (const { heading, content } of sections) {
    // Activity travels line by line, the way taskFields sends it.
    const pieces = heading === 'Activity' ? content.split('\n') : [content];
    for (const piece of pieces) {
      const hit = over(`body (section "${heading}")`, piece, cap);
      if (hit !== null) return hit;
    }
  }
  return null;
}

// Packs fields in key order, then Activity lines, greedily into pieces that
// fit `budget`; only the first carries `origin` (spec "Task ops").
export function splitChange(change: TaskChange, budget: number): TaskChange[] {
  if (change.kind === 'remove' || jsonBytes(change) <= budget) return [change];
  const start = (first: boolean): TaskChange => ({
    task: change.task,
    kind: change.kind,
    ...(first && change.origin !== undefined ? { origin: change.origin } : {}),
  });
  const pieces: TaskChange[] = [];
  let current = start(true);
  const empty = (p: TaskChange): boolean =>
    p.fields === undefined && p.activity === undefined;
  const flush = (): void => {
    if (!empty(current)) pieces.push(current);
    current = start(pieces.length === 0);
  };
  for (const key of Object.keys(change.fields ?? {}).sort()) {
    const value = change.fields?.[key];
    const next: TaskChange = {
      ...current,
      fields: { ...current.fields, [key]: value },
    };
    if (jsonBytes(next) > budget && !empty(current)) {
      flush();
      current = { ...current, fields: { [key]: value } };
    } else current = next;
  }
  for (const line of change.activity ?? []) {
    const next: TaskChange = {
      ...current,
      activity: [...(current.activity ?? []), line],
    };
    if (jsonBytes(next) > budget && !empty(current)) {
      flush();
      current = { ...current, activity: [line] };
    } else current = next;
  }
  flush();
  return pieces;
}

// Signs task changes as v2 ops on this replica's chain once a team is founded.
export class TaskOpSigner {
  constructor(
    private readonly deps: {
      ledger: SyncLedger;
      fed: FedStore;
      roster: RosterService;
      v1Copy?: (op: FederatedOp, piece: TaskChange) => void;
    }
  ) {}

  active(): boolean {
    return this.deps.roster.founded();
  }

  // Whether the team's content goes out e2e, so ops carry ciphertext.
  private e2e(): boolean {
    return this.deps.fed.content?.current() != null;
  }

  /** The largest field one task op carries. */
  fieldCap(): number {
    return this.e2e() ? E2E_TASK_FIELD_BYTES : MAX_TASK_FIELD_BYTES;
  }

  /** Before a write: refused while this machine lacks the team's content key,
   *  so a change is never made here and left unsynced. */
  assertCanPublish(): void {
    const missing = this.deps.fed.content?.missing() ?? null;
    if (missing !== null) throw new ContentKeyMissingError(missing);
  }

  // Each piece is recorded in the merge state under the clock it travels with,
  // so every replica holds the same clock for every field.
  commit(change: TaskChange): FederatedOp[] {
    const { ledger, fed } = this.deps;
    const fields: Record<string, unknown> = {};
    const cap = this.fieldCap();
    for (const [key, value] of Object.entries(change.fields ?? {})) {
      // No op can carry it, and one that tried would wedge the chain (F-D36).
      if (jsonBytes(value ?? null) > cap)
        fed.problem(
          `task:${change.task}`,
          `${key} of ${change.task} is over the ${cap / 1024} KiB sync limit and was not sent; shorten it`
        );
      else fields[key] = value;
    }
    // A change whose every field was left out has nothing left to send.
    if (
      change.fields !== undefined &&
      Object.keys(fields).length === 0 &&
      (change.activity ?? []).length === 0
    )
      return [];
    const trimmed: TaskChange =
      change.fields === undefined ? change : { ...change, fields };
    const pieces = splitChange(
      trimmed,
      this.e2e() ? E2E_TASK_BODY_BYTES : MAX_OP_BYTES - OP_ENVELOPE_BYTES
    );
    // E2e content never leaves in a v1 copy, which is plain text.
    const v1Copy = this.e2e() ? undefined : this.deps.v1Copy;
    return ledger.atomically(() =>
      pieces.map((piece) =>
        fed.append({
          type: 'task',
          body: piece as unknown as JsonValue,
          onStamp: (stamp) => {
            recordLocal(
              { v: 1, replica: ledger.replica, ...stamp, ...piece },
              ledger.state
            );
          },
          ...(v1Copy === undefined
            ? {}
            : { alsoV1: (op: FederatedOp) => v1Copy(op, piece) }),
        })
      )
    );
  }
}
