import { speaksForHandle } from '@dispatch/federation';
import type { RosterView } from '@dispatch/federation';
import { MEMORY_ID_PATTERN, MEMORY_KINDS } from '@dispatch/memory';
import type { MemoryEntry, MemoryTrust } from '@dispatch/memory';
import { parseAddress } from '@dispatch/protocol';
import type { Address } from '@dispatch/protocol';
import { compareHlc, parseOpHlc } from '@dispatch/protocol/federation';
import type { FederatedOp, MemoryBody } from '@dispatch/protocol/federation';

import type { RosterService } from './roster.js';
import type { Collector, OpHandler, StageContext } from './service.js';
import { standsAt } from './service.js';
import type { FedStore } from './store.js';
import { dropNote } from './validate.js';

/** The entry fields a `memory` op carries; never trust, decay, recalls or revisions. */
const MEMORY_FIELDS = [
  'title',
  'body',
  'kind',
  'refs',
  'epic',
  'appliesTo',
  'pinned',
  'status',
  'statusReason',
  'supersedes',
  'supersededBy',
  'author',
  'createdAt',
  'decidedBy',
  'decidedByPolicy',
] as const;
type MemoryField = (typeof MEMORY_FIELDS)[number];
type MemoryFields = Partial<Record<MemoryField, unknown>>;

// A change to any of these re-derives trust; any other never lowers it.
const CONTENT_FIELDS: readonly MemoryField[] = [
  'title',
  'body',
  'kind',
  'refs',
];
// Changed team entries read per pass.
const BATCH = 500;
// Entries projected into memory.db per pass.
const PROJECT_BATCH = 200;

/** What federation needs from memory v1 (memory/teamPort.ts builds it). */
export interface TeamMemoryPort {
  /** Every team entry, active or retired. */
  teamEntries(): MemoryEntry[];
  /** The newest revision mark, 0 when there is none. */
  latestRev(): number;
  /** Team entries changed after `sinceRev` by anything but decay or sync;
   *  `through` is the last mark read. */
  changedTeamEntries(
    sinceRev: number,
    limit: number
  ): { entries: MemoryEntry[]; through: number };
  /** Ids with a local change after `sinceRev` that is not yet published. */
  unpublished(sinceRev: number): Set<string>;
  /** The trust memory.db holds for `id`, or null when it holds no entry. */
  heldTrust(id: string): MemoryTrust | null;
  /** Writes the team's merged entry, or opens or updates a proposal when
   *  this daemon's policy would block what another's approved. */
  applyRemote(input: {
    id: string;
    fields: MemoryFields;
    trust: MemoryTrust;
    replica: string;
  }): 'entry' | 'proposal' | 'ignored' | 'invalid';
}

const RANK: Record<MemoryTrust, number> = { agent: 0, confirmed: 1, human: 2 };

/**
 * Q10: a publisher that speaks for the human author keeps `human`, for the
 * human decider keeps `confirmed`; anything else is `agent`. A content
 * change re-derives trust; any other change never lowers the trust held.
 * Judged once, on arrival: a later roster change leaves held trust alone.
 */
export function arrivalTrust(input: {
  asserted: MemoryTrust;
  author: Address;
  decidedBy: Address | null;
  publisher: string;
  seq: number;
  view: RosterView;
  held: MemoryTrust | null;
  contentChanged: boolean;
}): MemoryTrust {
  const { view, publisher, seq } = input;
  const speaksFor = (address: Address | null): boolean =>
    address !== null &&
    address.startsWith('human:') &&
    standsAt(view, publisher, seq) &&
    speaksForHandle(view, publisher, address.slice('human:'.length), seq);
  let derived: MemoryTrust = 'agent';
  if (input.asserted === 'human' && speaksFor(input.author)) derived = 'human';
  else if (input.asserted === 'confirmed' && speaksFor(input.decidedBy))
    derived = 'confirmed';
  if (input.contentChanged || input.held === null) return derived;
  return RANK[derived] > RANK[input.held] ? derived : input.held;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown, max: number): boolean =>
  typeof v === 'string' && v.length <= max;
const isAddressOf = (v: unknown, kinds: readonly string[]): boolean => {
  if (typeof v !== 'string') return false;
  try {
    return kinds.includes(parseAddress(v).kind);
  } catch {
    return false;
  }
};
const isMemoryId = (v: unknown): boolean =>
  v === null || (typeof v === 'string' && MEMORY_ID_PATTERN.test(v));

// Each field's shape; memory.db's own validation checks content on apply.
const FIELD_OK: Record<MemoryField, (v: unknown) => boolean> = {
  title: (v) => isText(v, 1024),
  body: (v) => isText(v, 64 * 1024),
  kind: (v) => (MEMORY_KINDS as readonly unknown[]).includes(v),
  refs: (v) => Array.isArray(v) && v.length <= 64,
  epic: (v) => v === null || isText(v, 64),
  appliesTo: (v) =>
    Array.isArray(v) && v.length <= 64 && v.every((p) => isText(p, 512)),
  pinned: (v) => typeof v === 'boolean',
  status: (v) => v === 'active' || v === 'retired',
  statusReason: (v) =>
    v === null || v === 'forgotten' || v === 'superseded' || v === 'undone',
  supersedes: isMemoryId,
  supersededBy: isMemoryId,
  author: (v) => isAddressOf(v, ['human', 'agent', 'run']),
  createdAt: (v) =>
    typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)),
  decidedBy: (v) => v === null || isAddressOf(v, ['human']),
  decidedByPolicy: (v) =>
    v === null ||
    (isObj(v) &&
      Number.isInteger(v['rung']) &&
      (v['authorizedBy'] === 'rung' || v['authorizedBy'] === 'override')),
};

/** A `memory` op body read field by field, or null; unknown fields are left out. */
function memoryBody(
  v: unknown
): (MemoryBody & { fields: MemoryFields }) | null {
  if (!isObj(v)) return null;
  const { memory, kind, trust, fields } = v;
  if (typeof memory !== 'string' || !MEMORY_ID_PATTERN.test(memory))
    return null;
  if (kind !== 'put' && kind !== 'remove') return null;
  if (trust !== 'human' && trust !== 'confirmed' && trust !== 'agent')
    return null;
  if (fields !== undefined && !isObj(fields)) return null;
  const read: MemoryFields = {};
  for (const f of MEMORY_FIELDS) {
    if (fields === undefined || !(f in fields)) continue;
    if (!FIELD_OK[f](fields[f])) return null;
    read[f] = fields[f];
  }
  return { memory, kind, trust, fields: read };
}

// Whether hlc `a` is later than `b`, the replica breaking a tie.
function later(a: string, b: string): boolean {
  const [pa, pb] = [parseOpHlc(a), parseOpHlc(b)];
  if (pa === null || pb === null) return a > b;
  const c = compareHlc(pa, pb);
  return c === 0 ? pa.replica > pb.replica : c > 0;
}

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

interface FieldRow {
  field: MemoryField;
  hlc: string;
  value_json: string;
}
interface EntryRow {
  memory: string;
  trust: MemoryTrust;
  origin_replica: string;
}

/**
 * Team memory on signed `memory` ops. Publishes each changed team entry's
 * fields that differ from what the team merged; merges arriving fields last
 * writer wins per field on the hlc in fed_memory_fields, and after each pass
 * writes the merged entries into memory.db through the port.
 */
export class MemorySync implements Collector, OpHandler {
  readonly order = 5;
  readonly type = 'memory';

  constructor(
    private readonly deps: {
      fed: FedStore;
      roster: RosterService;
      port: TeamMemoryPort;
    }
  ) {}

  collect(): void {
    const { fed, roster, port } = this.deps;
    // Nothing goes to a team this machine is not firmly in.
    if (fed.head() === null || !roster.mailReady()) return;
    const mark = fed.meta('memory_rev');
    if (mark === null) {
      // The first pass sends every team entry the team has not heard of.
      const through = port.latestRev();
      for (const entry of port.teamEntries())
        if (this.entryRow(entry.id) === null) this.publish(entry);
      fed.setMeta('memory_rev', String(through));
      return;
    }
    const { entries, through } = port.changedTeamEntries(Number(mark), BATCH);
    for (const entry of entries) this.publish(entry);
    fed.setMeta('memory_rev', String(through));
  }

  stage(op: FederatedOp, ctx: StageContext): 'applied' | 'parked' | 'dropped' {
    const { fed, roster, port } = this.deps;
    const body = memoryBody(op.body);
    if (body === null) {
      dropNote(
        fed,
        'malformed',
        op.replica,
        `${roster.label(op.replica)}'s memory op at seq ${op.seq} is not a valid team entry; it was dropped`
      );
      return 'dropped';
    }
    // A hard delete stays on its machine in F3.
    if (body.kind === 'remove') return 'dropped';
    const id = body.memory;
    const prior = this.fields(id);
    const won: MemoryFields = {};
    for (const [f, value] of Object.entries(body.fields) as [
      MemoryField,
      unknown,
    ][]) {
      const held = prior.get(f);
      if (held !== undefined && !later(op.hlc, held.hlc)) continue;
      won[f] = value;
      this.putField(id, f, op.hlc, value);
    }
    // An op every field of which lost says nothing new, trust included.
    if (Object.keys(body.fields).length > 0 && Object.keys(won).length === 0)
      return 'applied';
    const before = new Map(
      [...prior].map(([f, row]) => [f, JSON.parse(row.value_json) as unknown])
    );
    const merged = new Map(before);
    for (const [f, value] of Object.entries(won))
      merged.set(f as MemoryField, value);
    const contentChanged = CONTENT_FIELDS.some(
      (f) => f in won && !same(won[f], before.get(f))
    );
    const row = this.entryRow(id);
    const trust = arrivalTrust({
      asserted: body.trust,
      author: (merged.get('author') ?? '') as Address,
      decidedBy: (merged.get('decidedBy') ?? null) as Address | null,
      publisher: op.replica,
      seq: op.seq,
      view: ctx.view,
      held: port.heldTrust(id) ?? row?.trust ?? null,
      contentChanged,
    });
    fed.db
      .query(
        'INSERT INTO fed_memory (memory, trust, origin_replica, dirty) VALUES (?, ?, ?, 1) ON CONFLICT (memory) DO UPDATE SET trust = excluded.trust, dirty = 1'
      )
      .run(id, trust, op.replica);
    return 'applied';
  }

  /** After a pass: memory.db follows what the team merged, except an entry
   *  with a local change still to publish, which the next pass sends first. */
  passComplete(): void {
    const { fed, roster, port } = this.deps;
    const mark = fed.meta('memory_rev');
    const local =
      mark === null ? new Set<string>() : port.unpublished(Number(mark));
    const rows = fed.db
      .query<EntryRow, [number]>(
        'SELECT memory, trust, origin_replica FROM fed_memory WHERE dirty = 1 LIMIT ?'
      )
      .all(PROJECT_BATCH);
    for (const row of rows) {
      if (local.has(row.memory)) continue;
      const fields: MemoryFields = {};
      for (const [f, r] of this.fields(row.memory))
        fields[f] = JSON.parse(r.value_json) as unknown;
      let out: ReturnType<TeamMemoryPort['applyRemote']>;
      try {
        out = port.applyRemote({
          id: row.memory,
          fields,
          trust: row.trust,
          replica: row.origin_replica,
        });
      } catch (err) {
        // memory.db is down or busy: the entry stays dirty for a later pass.
        console.error('dispatchd: team memory was not applied', err);
        continue;
      }
      if (out === 'invalid')
        dropNote(
          fed,
          'malformed',
          row.origin_replica,
          `${roster.label(row.origin_replica)}'s team memory ${row.memory} is not a valid entry, so it was not applied`
        );
      fed.db
        .query('UPDATE fed_memory SET dirty = 0 WHERE memory = ?')
        .run(row.memory);
    }
  }

  // The fields of `entry` that differ from what the team merged (all of them
  // for an entry the team never heard of), with its trust as an assertion.
  private publish(entry: MemoryEntry): void {
    const { fed } = this.deps;
    const prior = this.fields(entry.id);
    const row = this.entryRow(entry.id);
    const fields: MemoryFields = {};
    for (const f of MEMORY_FIELDS) {
      const held = prior.get(f);
      if (held === undefined || !same(JSON.parse(held.value_json), entry[f]))
        fields[f] = entry[f];
    }
    if (Object.keys(fields).length === 0 && row?.trust === entry.trust) return;
    const body: MemoryBody = {
      memory: entry.id,
      kind: 'put',
      fields,
      trust: entry.trust,
    };
    fed.append({
      type: 'memory',
      body: { ...body } as never,
      onStamp: (stamp) => {
        for (const [f, value] of Object.entries(fields))
          this.putField(entry.id, f as MemoryField, stamp.hlc, value);
        fed.db
          .query(
            'INSERT INTO fed_memory (memory, trust, origin_replica, dirty) VALUES (?, ?, ?, 0) ON CONFLICT (memory) DO UPDATE SET trust = excluded.trust'
          )
          .run(entry.id, entry.trust, fed.replica);
      },
    });
  }

  private fields(id: string): Map<MemoryField, FieldRow> {
    const rows = this.deps.fed.db
      .query<FieldRow, [string]>(
        'SELECT field, hlc, value_json FROM fed_memory_fields WHERE memory = ?'
      )
      .all(id);
    return new Map(rows.map((r) => [r.field, r]));
  }

  private putField(
    id: string,
    field: MemoryField,
    hlc: string,
    value: unknown
  ): void {
    this.deps.fed.db
      .query(
        'INSERT OR REPLACE INTO fed_memory_fields (memory, field, hlc, value_json) VALUES (?, ?, ?, ?)'
      )
      .run(id, field, hlc, JSON.stringify(value ?? null));
  }

  private entryRow(id: string): EntryRow | null {
    return this.deps.fed.db
      .query<EntryRow, [string]>(
        'SELECT memory, trust, origin_replica FROM fed_memory WHERE memory = ?'
      )
      .get(id);
  }
}
