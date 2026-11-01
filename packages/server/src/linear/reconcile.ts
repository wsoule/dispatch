// One sync pass's writes: a task and its Linear record reconciled field by
// field, new records created on either side, and every write recorded (merge
// base, echo, chip link) so the next pass sees exactly what changed since.
import {
  containerCreate,
  fieldHash,
  getSection,
  INITIATIVE_FIELDS,
  initiativePatch,
  initiativePush,
  initiativeValues,
  isDoneStatus,
  isOutstanding,
  ISSUE_FIELDS,
  ISSUE_FOLLOW_UP_FIELDS,
  issuePatch,
  issuePush,
  issueTaskCreate,
  issueValues,
  labelCollision,
  linearExternal,
  mergeFields,
  MILESTONE_FIELDS,
  milestonePatch,
  milestonePush,
  milestoneValues,
  missingLabels,
  newTaskDoc,
  nextBase,
  parseLinearExternal,
  PROJECT_FIELDS,
  projectPatch,
  projectPush,
  projectValues,
  PULL_ONLY_CONTAINER_FIELDS,
  PULL_ONLY_ISSUE_FIELDS,
  replaceableIssueFields,
  splitSections,
  taskInitiativeValues,
  taskIssueValues,
  taskMilestoneValues,
  taskProjectValues,
  untrustedIssueFields,
} from '@dispatch-foo/core';
import type {
  CreateInput,
  DispatchConfig,
  FieldValues,
  LabelColorPush,
  LinearEntity,
  LinearInitiative,
  LinearIssue,
  LinearLabel,
  LinearLabelMatch,
  LinearProject,
  LinearProjectMilestone,
  TaskDoc,
  TaskStorePort,
  UpdatePatch,
} from '@dispatch-foo/core';

import type { TaskChangeBatch } from './batch.js';
import type {
  LinearClient,
  LinearErrorKind,
  LinearFailure,
  LinearResult,
} from './client.js';
import { LINEAR_USAGE_LIMIT_MESSAGE } from './client.js';
import type { ConflictRecord, LinearSyncState } from './state.js';
import {
  CAPACITY_RETRY_MS,
  readBase,
  recordConflicts,
  writeBase,
} from './state.js';
import type { PassContext } from './workspace.js';
import { linkedIssueTeam, track, trackLabel } from './workspace.js';

/** One sync's outcome. `created` counts new local tasks; `createdIssues` counts new Linear records. */
export interface LinearSyncSummary {
  at: string;
  pulled: number;
  pushed: number;
  created: number;
  createdIssues: number;
  conflicts: number;
  errors: string[];
  rateLimited: boolean;
  /** Linear refused a create over the plan's issue limit; later creates were skipped. */
  usageLimited: boolean;
  /** Named creates still waiting to land after the pass. */
  queued: number;
  /** Tasks whose create failed this pass. */
  failedTaskIds: string[];
  /** Tasks whose status moved onto a regenerated workflow state. */
  migrated: number;
  /** Closed issues archived in Linear. */
  archivedIssues: number;
}

export function emptySummary(at: string): LinearSyncSummary {
  return {
    at,
    pulled: 0,
    pushed: 0,
    created: 0,
    createdIssues: 0,
    conflicts: 0,
    errors: [],
    rateLimited: false,
    usageLimited: false,
    queued: 0,
    failedTaskIds: [],
    migrated: 0,
    archivedIssues: 0,
  };
}

/** Any Linear record a task can mirror. */
export type RemoteRecord =
  | LinearIssue
  | LinearProject
  | LinearProjectMilestone
  | LinearInitiative;

/** What one entity kind's reconciliation needs to know about its records. */
interface EntityOps<R extends RemoteRecord> {
  entity: LinearEntity;
  fields: readonly string[];
  pullOnly: ReadonlySet<string>;
  remote(r: R, ctx: PassContext): FieldValues;
  local(doc: TaskDoc, ctx: PassContext): FieldValues;
  patch(r: R, fields: string[], doc: TaskDoc, ctx: PassContext): UpdatePatch;
  unknown(r: R): Set<string>;
  /** Fields holding a placeholder this pass can replace (MergeInput.refresh). */
  refresh?(doc: TaskDoc, r: R, ctx: PassContext): ReadonlySet<string>;
}

/** What a chip shows for a record; milestones have no page of their own. */
function chipFor(r: RemoteRecord): { identifier: string; url: string } | null {
  if ('identifier' in r) return { identifier: r.identifier, url: r.url };
  if ('url' in r) return { identifier: r.name, url: r.url };
  return null;
}

const ISSUE_OPS: EntityOps<LinearIssue> = {
  entity: 'issue',
  fields: ISSUE_FIELDS,
  pullOnly: PULL_ONLY_ISSUE_FIELDS,
  remote: issueValues,
  local: taskIssueValues,
  patch: issuePatch,
  unknown: (r) => untrustedIssueFields(r.truncated),
  refresh: replaceableIssueFields,
};

const PROJECT_OPS: EntityOps<LinearProject> = {
  entity: 'project',
  fields: PROJECT_FIELDS,
  pullOnly: PULL_ONLY_CONTAINER_FIELDS,
  remote: projectValues,
  local: taskProjectValues,
  patch: projectPatch,
  unknown: () => new Set(),
};

const MILESTONE_OPS: EntityOps<LinearProjectMilestone> = {
  entity: 'milestone',
  fields: MILESTONE_FIELDS,
  pullOnly: PULL_ONLY_CONTAINER_FIELDS,
  remote: milestoneValues,
  local: taskMilestoneValues,
  patch: milestonePatch,
  unknown: () => new Set(),
};

const INITIATIVE_OPS: EntityOps<LinearInitiative> = {
  entity: 'initiative',
  fields: INITIATIVE_FIELDS,
  pullOnly: PULL_ONLY_CONTAINER_FIELDS,
  remote: initiativeValues,
  local: taskInitiativeValues,
  patch: initiativePatch,
  unknown: () => new Set(),
};

// A link made before field-level sync has no base. Only the fields the
// whole-record sync used to push may go out on that first contact; for the
// rest a local value is not known to be an edit, so Linear's wins.
const FIRST_CONTACT_PUSH: ReadonlySet<string> = new Set([
  'title',
  'description',
  'state',
  'priority',
]);

/** How a pair may be written this pass. */
export interface ReconcileMode {
  mayPull: boolean;
  mayPush: boolean;
  /** Named in an explicit push: treated as holding an unsent edit. */
  explicit?: boolean;
}

const OPS_BY_ENTITY: Record<LinearEntity, EntityOps<RemoteRecord>> = {
  issue: ISSUE_OPS as unknown as EntityOps<RemoteRecord>,
  project: PROJECT_OPS as unknown as EntityOps<RemoteRecord>,
  milestone: MILESTONE_OPS as unknown as EntityOps<RemoteRecord>,
  initiative: INITIATIVE_OPS as unknown as EntityOps<RemoteRecord>,
};

const CREATE_KEYS = [
  'title',
  'status',
  'priority',
  'labels',
  'assignee',
  'estimate',
  'dueDate',
  'startDate',
  'cycle',
  'blockedBy',
  'relatedTo',
  'duplicateOf',
  'initiatives',
  'color',
  'icon',
  'sortOrder',
  'creator',
] as const;

const TEMPLATE_SECTIONS = new Set([
  'Description',
  'Acceptance Criteria',
  'Activity',
]);

// The part of a pull patch a create can carry: every plain field, a resolved
// parent, and the description when the body is just the template around it.
function createFields(patch: UpdatePatch): Partial<CreateInput> {
  const out: Record<string, unknown> = {};
  for (const key of CREATE_KEYS) {
    if (patch[key] !== undefined) out[key] = patch[key];
  }
  if (patch.parent !== undefined && patch.parent !== null) {
    out.parent = patch.parent;
  }
  const body = patch.body;
  if (body !== undefined) {
    const plain = splitSections(body).sections.every(
      (s) =>
        TEMPLATE_SECTIONS.has(s.heading) &&
        (s.heading === 'Description' || s.content.trim() === '')
    );
    if (plain) out.description = getSection(body, 'Description');
  }
  return out as Partial<CreateInput>;
}

const RELATION_FIELD: Record<string, string> = {
  blocks: 'blockedBy',
  related: 'relatedTo',
  duplicate: 'duplicateOf',
};

/** Thrown out of a write once Linear throttles, so the pass stops spending. */
class Halted extends Error {}

export interface PassDeps {
  store: TaskStorePort;
  client: LinearClient;
  config: DispatchConfig;
  /** The primary linked team: where a new record goes unless its parent's
   *  team is another linked one. */
  teamId: string;
  /** Linked team key (an identifier's prefix, `ENG`) -> team id. */
  teamByKey: ReadonlyMap<string, string>;
  state: LinearSyncState;
  summary: LinearSyncSummary;
  ctx: PassContext;
  docs: Map<string, TaskDoc>;
  batch: TaskChangeBatch;
  /** Records a failure's message and arms the backoff on a throttle. */
  note: (failure: LinearFailure) => string;
  /** Hears every label the pass creates or recolors, to keep caches current. */
  onLabel: (label: LinearLabel) => void;
  /** Labels Linear holds in a form no team here can apply (a group, a
   *  retired label), by team and lowercased name: the reason, and until when
   *  it is not looked up again. Kept across passes by the engine. */
  blockedLabels?: Map<string, { reason: string; until: number }>;
}

// How long a label found blocked is not looked up again.
const BLOCKED_LABEL_MS = 30 * 60_000;

// The Halted a throw carries; anything else is rethrown.
function haltOf(err: unknown): Halted {
  if (err instanceof Halted) return err;
  throw err;
}

function later(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** Which Linear record a local task should become, by kind and ancestry. */
function entityForNewTask(doc: TaskDoc, ctx: PassContext): LinearEntity {
  const kind = doc.meta.kind;
  if (kind === 'initiative' || kind === 'project') return kind;
  if (kind === 'milestone') {
    // A milestone under a linked project is a project milestone; a legacy
    // milestone with no project is a parent issue its tasks hang under.
    return projectAbove(doc, ctx) === null ? 'issue' : 'milestone';
  }
  return 'issue';
}

function projectAbove(doc: TaskDoc, ctx: PassContext): string | null {
  const seen = new Set([doc.meta.id]);
  let cursor = doc.meta.parent;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = ctx.tasks.get(cursor);
    const ref = parseLinearExternal(parent?.external);
    if (ref?.entity === 'project') return ref.id;
    cursor = parent?.parent ?? null;
  }
  return null;
}

// A label with only LinearLabel's fields, so a lookup's flags stay out of the
// pass's indexes and the session's label cache.
function plainLabel(label: LinearLabel): LinearLabel {
  return {
    id: label.id,
    name: label.name,
    ...(label.color === undefined ? {} : { color: label.color }),
    group: label.group ?? null,
    teamId: label.teamId ?? null,
  };
}

/** A create's outcome; `capped` means the usage limit stopped it. */
export type CreateRemoteResult =
  | { created: true }
  | { created: false; error: string; capped: boolean };

// How deep a task sits, so parents are created before their children.
function depth(doc: TaskDoc, ctx: PassContext): number {
  const rank = { initiative: 0, project: 1, milestone: 2, task: 3 };
  let n = rank[doc.meta.kind] * 100;
  const seen = new Set([doc.meta.id]);
  let cursor = doc.meta.parent;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    n++;
    cursor = ctx.tasks.get(cursor)?.parent ?? null;
  }
  return n;
}

/** The writes of one pass, over one snapshot of the task store. */
export class LinearPass {
  private halted = false;
  // Set by the first usage-limit refusal: later creates are skipped.
  private capped = false;
  /** Pairs whose push waited on a newer Linear copy the pass could not take. */
  withheld = 0;
  /** The failure most recently recorded; createRemote clears it per create. */
  lastFailure: string | null = null;
  /** The client's kind for `lastFailure`; null for an engine-side reason. */
  lastFailureKind: LinearErrorKind | null = null;
  // Tasks this pass created from Linear, already counted as pulled.
  private readonly createdHere = new Set<string>();
  // Labels this pass failed to create, keyed by team and lowercased name.
  private readonly refusedLabels = new Set<string>();

  constructor(private readonly d: PassDeps) {}

  get stopped(): boolean {
    return this.halted;
  }

  /** Linear refused a create over the plan's issue limit this pass. */
  get atCapacity(): boolean {
    return this.capped;
  }

  get summary(): LinearSyncSummary {
    return this.d.summary;
  }

  /** A fetch's data, or null with the failure recorded; a throttle halts the pass. */
  take<T>(result: LinearResult<T>): T | null {
    return this.check(result);
  }

  /** Adds a failure to the summary and remembers it as `lastFailure`. */
  recordFailure(message: string, kind: LinearErrorKind | null = null): void {
    this.d.summary.errors.push(message);
    this.lastFailure = message;
    this.lastFailureKind = kind;
  }

  // Unwraps a client result, recording the failure. A throttle halts the
  // pass; the usage limit is recorded once and stops creates only.
  private check<T>(result: LinearResult<T>): T | null {
    if (result.ok) return result.data;
    if (result.kind === 'usage-limit') {
      if (!this.capped) {
        const message = this.d.note(result);
        this.recordFailure(message, result.kind);
        this.pause(message);
      }
      this.capped = true;
      this.d.summary.usageLimited = true;
      return null;
    }
    this.recordFailure(this.d.note(result), result.kind);
    if (result.kind === 'rate-limit') {
      this.d.summary.rateLimited = true;
      this.halted = true;
      throw new Halted();
    }
    return null;
  }

  // Persists the usage-limit pause, keeping the counts last measured.
  private pause(message: string): void {
    const now = Date.now();
    const prior = this.d.state.capacity;
    this.d.state.capacity = {
      limitedAt: new Date(now).toISOString(),
      retryAt: new Date(now + CAPACITY_RETRY_MS).toISOString(),
      message,
      active: prior?.active ?? null,
      limit: prior?.limit ?? null,
      limitSource: prior?.limitSource ?? null,
      plan: prior?.plan ?? 'unknown',
      checkedAt: prior?.checkedAt ?? null,
    };
  }

  /** Runs a write batch, turning a throttle into a quiet stop. */
  async guarded(work: () => Promise<void>): Promise<void> {
    if (this.halted) return;
    try {
      await work();
    } catch (err) {
      if (!(err instanceof Halted)) throw err;
    }
  }

  private write(id: string, patch: UpdatePatch, stamp: string): TaskDoc {
    const doc = this.d.store.update(id, patch, stamp);
    this.d.docs.set(id, doc);
    track(this.d.ctx, doc);
    this.d.batch.add(id);
    return doc;
  }

  recordEcho(id: string, updatedAt: string): void {
    this.d.state.echoes.push({
      issueId: id,
      updatedAt,
      recordedAt: new Date().toISOString(),
    });
    this.echoIndex?.add(`${id}@${updatedAt}`);
  }

  // Built on first use: a pull asks about every record it read.
  private echoIndex: Set<string> | null = null;

  isEcho(id: string, updatedAt: string): boolean {
    this.echoIndex ??= new Set(
      this.d.state.echoes.map((e) => `${e.issueId}@${e.updatedAt}`)
    );
    return this.echoIndex.has(`${id}@${updatedAt}`);
  }

  recordLink(id: string, identifier: string, url: string): void {
    this.d.state.links[id] = { identifier, url };
  }

  /** Records a record's chip, when it has one. */
  recordChip(r: RemoteRecord): void {
    const chip = chipFor(r);
    if (chip !== null) this.recordLink(r.id, chip.identifier, chip.url);
  }

  // ---------------------------------------------------------------------------
  // Pairs: a linked task and its record, field by field.

  async reconcileIssue(
    doc: TaskDoc,
    issue: LinearIssue,
    mode: ReconcileMode
  ): Promise<void> {
    await this.reconcile(ISSUE_OPS, doc, issue, mode, (d, f, r) =>
      this.pushIssue(d, f, r)
    );
  }

  async reconcileProject(
    doc: TaskDoc,
    project: LinearProject,
    mode: ReconcileMode
  ): Promise<void> {
    await this.reconcile(PROJECT_OPS, doc, project, mode, (d, f, r) =>
      this.pushProject(d, f, r)
    );
  }

  async reconcileMilestone(
    doc: TaskDoc,
    milestone: LinearProjectMilestone,
    mode: ReconcileMode
  ): Promise<void> {
    await this.reconcile(MILESTONE_OPS, doc, milestone, mode, (d, f, r) =>
      this.pushMilestone(d, f, r)
    );
  }

  async reconcileInitiative(
    doc: TaskDoc,
    initiative: LinearInitiative,
    mode: ReconcileMode
  ): Promise<void> {
    await this.reconcile(INITIATIVE_OPS, doc, initiative, mode, (d, f, r) =>
      this.pushInitiative(d, f, r)
    );
  }

  // The task as it is now, when the merge would replace a placeholder: a
  // refresh pulls without a base, and the pass's snapshot can predate a
  // person reassigning the task while the pass waited on Linear.
  private beforeRefresh<R extends RemoteRecord>(
    ops: EntityOps<R>,
    doc: TaskDoc,
    remote: R
  ): TaskDoc {
    if (ops.refresh === undefined) return doc;
    if (ops.refresh(doc, remote, this.d.ctx).size === 0) return doc;
    const current = this.d.store.get(doc.meta.id);
    if (current === null) return doc;
    this.d.docs.set(current.meta.id, current);
    track(this.d.ctx, current);
    return current;
  }

  private async reconcile<R extends RemoteRecord>(
    ops: EntityOps<R>,
    snapshot: TaskDoc,
    remote: R,
    mode: ReconcileMode,
    push: (doc: TaskDoc, fields: string[], remote: R) => Promise<PushResult<R>>
  ): Promise<void> {
    const { ctx, state, summary } = this.d;
    const { mayPull, mayPush } = mode;
    const doc = this.beforeRefresh(ops, snapshot, remote);
    const id = doc.meta.id;
    const base = readBase(state, id, ops.entity);
    const unknown = ops.unknown(remote);
    const remoteValues = ops.remote(remote, ctx);
    const decisions = mergeFields({
      fields: ops.fields,
      local: ops.local(doc, ctx),
      remote: remoteValues,
      base,
      localUpdated: doc.meta.updated,
      remoteUpdated: remote.updatedAt,
      localDirty:
        mode.explicit === true ||
        isOutstanding(doc.meta.updated, state.pushed[id]),
      pullOnly: ops.pullOnly,
      unknown,
      ...(ops.entity === 'issue' ? { noBasePush: FIRST_CONTACT_PUSH } : {}),
      ...(ops.refresh === undefined
        ? {}
        : { refresh: ops.refresh(doc, remote, ctx) }),
    });
    const keep = new Set(unknown);
    const pulls: string[] = [];
    const pushes: string[] = [];
    // A direction the config turns off keeps that side's base, so the change
    // is still there to send once the direction allows it.
    let heldBack = false;
    for (const d of decisions) {
      if (d.action === 'pull') {
        if (mayPull) pulls.push(d.field);
        else keep.add(d.field);
      } else if (d.action === 'push') {
        if (mayPush) pushes.push(d.field);
        else {
          keep.add(d.field);
          heldBack = true;
        }
      }
    }
    // A finished task's archive (linear.archiveFinished) is not sent in the
    // pass that pulls its issue reopened: the field is rebased instead.
    const reopened = remoteValues.state;
    if (
      ops.entity === 'issue' &&
      pulls.includes('state') &&
      pushes.includes('archived') &&
      typeof reopened === 'string' &&
      isDoneStatus(doc.meta.status, ctx.model) &&
      !isDoneStatus(reopened, ctx.model)
    ) {
      pushes.splice(pushes.indexOf('archived'), 1);
    }
    // An unrecorded link Linear holds a newer copy of, in a pass that may not
    // take it: the push waits, and the summary says why.
    if (
      base === null &&
      !mayPull &&
      decisions.some((d) => d.action === 'pull')
    ) {
      this.withheld++;
    }
    const conflicts: ConflictRecord[] = decisions
      .filter(
        (d) =>
          d.conflict && (pulls.includes(d.field) || pushes.includes(d.field))
      )
      .map((d) => ({
        taskId: id,
        field: d.field,
        kept: d.action === 'push' ? 'local' : 'remote',
        at: summary.at,
      }));

    let current = doc;
    const note =
      conflicts.length === 0
        ? undefined
        : `Linear sync conflict: ${conflicts.map((c) => `${c.field} kept the ${c.kept === 'local' ? 'Dispatch' : 'Linear'} edit`).join('; ')}`;
    if (pulls.length > 0) {
      const patch = ops.patch(remote, pulls, current, ctx);
      if (note !== undefined) {
        patch.appendActivity = note;
        patch.activityActor = 'none';
      }
      current = this.write(
        id,
        patch,
        later(doc.meta.updated, remote.updatedAt)
      );
      if (!this.createdHere.has(id)) summary.pulled++;
    } else if (note !== undefined) {
      // Bookkeeping only: the note must not make the task look edited.
      current = this.write(
        id,
        { appendActivity: note, activityActor: 'none' },
        current.meta.updated
      );
    }
    summary.conflicts += conflicts.length;
    recordConflicts(state, conflicts);

    let remoteAfter = remote;
    let assumed: FieldValues = {};
    if (pushes.length > 0) {
      const result = await push(current, pushes, remote);
      remoteAfter = result.remote;
      assumed = result.assumed;
      for (const f of result.failed) keep.add(f);
      if (result.failed.size < pushes.length) summary.pushed++;
      this.recordEcho(remoteAfter.id, remoteAfter.updatedAt);
    }
    writeBase(
      state,
      id,
      ops.entity,
      ops.fields,
      nextBase(
        ops.fields,
        ops.local(current, ctx),
        { ...ops.remote(remoteAfter, ctx), ...assumed },
        base,
        keep
      )
    );
    if (!heldBack && !pushes.some((f) => keep.has(f))) {
      state.pushed[id] = current.meta.updated;
    }
    this.recordEcho(remote.id, remote.updatedAt);
    this.recordChip(remote);
  }

  // ---------------------------------------------------------------------------
  // Pushes

  // Creates the labels a task carries that `teamId` lacks, in the registry's
  // color when it has one. A name Linear refused is not sent again this pass.
  private async ensureLabels(doc: TaskDoc, teamId: string): Promise<boolean> {
    const { ctx, client } = this.d;
    let ok = true;
    for (const name of missingLabels(doc, ctx, teamId)) {
      const key = `${teamId}\n${name.toLowerCase()}`;
      if (this.refusedLabels.has(key)) {
        ok = false;
        continue;
      }
      const blocked = this.d.blockedLabels?.get(key);
      if (blocked !== undefined && blocked.until > Date.now()) {
        this.recordFailure(blocked.reason);
        this.refusedLabels.add(key);
        ok = false;
        continue;
      }
      const color = ctx.labelColors.get(name.toLowerCase());
      const created = await client.createLabel({
        name,
        teamId,
        ...(color === undefined ? {} : { color }),
      });
      const label: LinearLabel | null = created.ok
        ? created.data
        : created.code === 'duplicate'
          ? await this.existingLabel(name, teamId, created)
          : this.check<LinearLabel>(created);
      if (label === null) {
        this.refusedLabels.add(key);
        ok = false;
      } else {
        trackLabel(ctx, label);
        this.d.onLabel(label);
      }
    }
    return ok;
  }

  // The label Linear holds under a name it refused as taken, when this team
  // can apply it; else null with the reason recorded. Group/Name also tries the leaf.
  private async existingLabel(
    name: string,
    teamId: string,
    refused: LinearFailure
  ): Promise<LinearLabel | null> {
    const leaf = name.slice(name.lastIndexOf('/') + 1);
    const matches: LinearLabelMatch[] = [];
    for (const spelling of leaf === name ? [name] : [leaf, name]) {
      const found = this.check(await this.d.client.labelsNamed(spelling));
      if (found === null) return null;
      matches.push(...found);
    }
    const hit = labelCollision(name, teamId, matches);
    if (hit === null) {
      this.recordFailure(this.d.note(refused), refused.kind);
      return null;
    }
    if ('blocked' in hit) {
      this.recordFailure(hit.blocked);
      this.d.blockedLabels?.set(`${teamId}\n${name.toLowerCase()}`, {
        reason: hit.blocked,
        until: Date.now() + BLOCKED_LABEL_MS,
      });
      return null;
    }
    return plainLabel(hit.reuse);
  }

  /** Writes local label colors to Linear; answers the ids whose write failed. */
  async pushLabelColors(
    pushes: readonly LabelColorPush[]
  ): Promise<Set<string>> {
    const pending = new Set(pushes.map((p) => p.id));
    await this.guarded(async () => {
      for (const push of pushes) {
        const label = this.check(
          await this.d.client.updateLabel(push.id, { color: push.color })
        );
        if (label === null) continue;
        pending.delete(push.id);
        trackLabel(this.d.ctx, label);
        this.d.onLabel(label);
      }
    });
    return pending;
  }

  private async pushIssue(
    doc: TaskDoc,
    fields: string[],
    remote: LinearIssue
  ): Promise<PushResult<LinearIssue>> {
    const { client, ctx } = this.d;
    const failed = new Set<string>();
    let latest = remote;
    const team = remote.team?.id ?? this.d.teamId;
    if (fields.includes('labels') && !(await this.ensureLabels(doc, team))) {
      failed.add('labels');
    }
    const plan = issuePush(doc, fields, remote, ctx);
    const scalar = Object.keys(plan.input);
    if (scalar.length > 0) {
      const updated = this.check(
        await client.updateIssue(remote.id, plan.input)
      );
      if (updated === null) {
        for (const f of fields) {
          if (!ISSUE_FOLLOW_UP_FIELDS.includes(f as never)) failed.add(f);
        }
      } else {
        latest = updated;
      }
    }
    const assumed = await this.followUps(doc, remote, plan, failed);
    // An unarchive takes a slot under the plan's cap, so it waits out a usage
    // limit with its base kept.
    if (plan.archive === false && this.capped) failed.add('archived');
    else if (plan.archive !== null) {
      const archived = this.check(
        plan.archive
          ? await client.archiveIssue(remote.id)
          : await client.unarchiveIssue(remote.id)
      );
      if (archived === null) failed.add('archived');
      else latest = archived;
    }
    return { remote: latest, failed, assumed };
  }

  // Relation and link writes, which Linear keeps as records of their own. A
  // successful one is assumed to have landed, so the base records the value
  // without a refetch.
  private async followUps(
    doc: TaskDoc,
    remote: LinearIssue,
    plan: ReturnType<typeof issuePush>,
    failed: Set<string>
  ): Promise<FieldValues> {
    const { client, ctx } = this.d;
    const touched = new Set<string>();
    for (const r of plan.relations.create) {
      const field = RELATION_FIELD[r.type] ?? 'relatedTo';
      touched.add(field);
      if (this.check(await client.createRelation(r)) === null)
        failed.add(field);
    }
    for (const relationId of plan.relations.remove) {
      const type =
        remote.relations.find((r) => r.id === relationId)?.type ?? '';
      const field = RELATION_FIELD[type] ?? 'relatedTo';
      touched.add(field);
      if (this.check(await client.deleteRelation(relationId)) === null) {
        failed.add(field);
      }
    }
    for (const link of plan.links.add) {
      touched.add('links');
      if (
        this.check(
          await client.linkAttachment(remote.id, link.url, link.title)
        ) === null
      ) {
        failed.add('links');
      }
    }
    for (const attachmentId of plan.links.remove) {
      touched.add('links');
      if (this.check(await client.deleteAttachment(attachmentId)) === null) {
        failed.add('links');
      }
    }
    const local = taskIssueValues(doc, ctx);
    const assumed: Record<string, unknown> = {};
    for (const field of touched) {
      if (!failed.has(field)) assumed[field] = local[field as never];
    }
    return assumed;
  }

  private async pushProject(
    doc: TaskDoc,
    fields: string[],
    remote: LinearProject
  ): Promise<PushResult<LinearProject>> {
    const { client, ctx } = this.d;
    const failed = new Set<string>();
    let latest = remote;
    const plan = projectPush(doc, fields, remote, ctx);
    if (Object.keys(plan.input).length > 0) {
      const updated = this.check(
        await client.updateProject(remote.id, plan.input)
      );
      if (updated === null) {
        for (const f of fields) if (f !== 'initiatives') failed.add(f);
      } else {
        latest = updated;
      }
    }
    let membership = true;
    for (const initiativeId of plan.link) {
      if (
        this.check(
          await client.linkProjectInitiative(remote.id, initiativeId)
        ) === null
      ) {
        membership = false;
      }
    }
    for (const linkId of plan.unlink) {
      if (this.check(await client.unlinkProjectInitiative(linkId)) === null) {
        membership = false;
      }
    }
    const assumed: Record<string, unknown> = {};
    if (plan.link.length + plan.unlink.length > 0) {
      if (membership) {
        assumed.initiatives = taskProjectValues(doc, ctx).initiatives;
      } else {
        failed.add('initiatives');
      }
    }
    return { remote: latest, failed, assumed };
  }

  private async pushMilestone(
    doc: TaskDoc,
    fields: string[],
    remote: LinearProjectMilestone
  ): Promise<PushResult<LinearProjectMilestone>> {
    const input = milestonePush(doc, fields, this.d.ctx);
    if (Object.keys(input).length === 0) {
      return { remote, failed: new Set(), assumed: {} };
    }
    const updated = this.check(
      await this.d.client.updateMilestone(remote.id, input)
    );
    return updated === null
      ? { remote, failed: new Set(fields), assumed: {} }
      : { remote: updated, failed: new Set(), assumed: {} };
  }

  private async pushInitiative(
    doc: TaskDoc,
    fields: string[],
    remote: LinearInitiative
  ): Promise<PushResult<LinearInitiative>> {
    const input = initiativePush(doc, fields, this.d.ctx);
    if (Object.keys(input).length === 0) {
      return { remote, failed: new Set(), assumed: {} };
    }
    const updated = this.check(
      await this.d.client.updateInitiative(remote.id, input)
    );
    return updated === null
      ? { remote, failed: new Set(fields), assumed: {} }
      : { remote: updated, failed: new Set(), assumed: {} };
  }

  // ---------------------------------------------------------------------------
  // New records on either side

  /** A new local task for a Linear record; its fields arrive via `reconcile*`. */
  createLocal(
    entity: LinearEntity,
    remote: RemoteRecord,
    status: string
  ): TaskDoc {
    const { store, ctx, state, summary } = this.d;
    const base =
      entity === 'issue'
        ? issueTaskCreate(remote as LinearIssue, ctx)
        : containerCreate(
            entity,
            remote as { id: string; name: string },
            status
          );
    // Everything the record already settles goes into the one create, so an
    // import writes most tasks once; references to records created later in
    // the pass, and bodies with sections of their own, follow in `reconcile*`.
    const ops = OPS_BY_ENTITY[entity];
    const blank = newTaskDoc(
      't-new',
      base.kind ?? 'task',
      base,
      remote.createdAt
    );
    const patch = ops.patch(remote, [...ops.fields], blank, ctx);
    const input: CreateInput = {
      ...base,
      ...createFields(patch),
      created: remote.createdAt,
    };
    const doc = store.create(input, remote.updatedAt);
    this.d.docs.set(doc.meta.id, doc);
    track(ctx, doc);
    this.d.batch.add(doc.meta.id);
    // Accounted for at once: nothing local is waiting to go the other way.
    state.pushed[doc.meta.id] = doc.meta.updated;
    summary.created++;
    summary.pulled++;
    this.createdHere.add(doc.meta.id);
    return doc;
  }

  /** Sorts unlinked tasks so containers and parents are created first, and
   *  open work before finished, so an issue limit cuts finished work first. */
  creationOrder(docs: TaskDoc[]): TaskDoc[] {
    const { ctx } = this.d;
    const keyed = docs.map((doc) => ({
      doc,
      depth: depth(doc, ctx),
      finished: isDoneStatus(doc.meta.status, ctx.model) ? 1 : 0,
    }));
    keyed.sort((a, b) =>
      a.depth === b.depth ? a.finished - b.finished : a.depth - b.depth
    );
    return keyed.map((k) => k.doc);
  }

  /** Creates and links the Linear record a local task should mirror; `archive`
   *  archives a new issue as it lands. Sends nothing once the pass is capped. */
  async createRemote(
    doc: TaskDoc,
    opts?: { archive?: boolean }
  ): Promise<CreateRemoteResult> {
    if (this.capped) {
      return {
        created: false,
        error: this.d.state.capacity?.message ?? LINEAR_USAGE_LIMIT_MESSAGE,
        capped: true,
      };
    }
    this.lastFailure = null;
    this.lastFailureKind = null;
    const { ctx, client, teamId, summary } = this.d;
    const entity = entityForNewTask(doc, ctx);
    const version = doc.meta.updated;
    let remote: RemoteRecord | null = null;
    let ops: EntityOps<RemoteRecord>;
    let assumed: FieldValues = {};
    const failed = new Set<string>();
    // A throttle after the record exists: it is linked first, so a retry
    // never creates it twice, and the pass stops once that is written.
    let halt: Halted | null = null;
    if (entity === 'initiative') {
      ops = INITIATIVE_OPS as unknown as EntityOps<RemoteRecord>;
      const input = initiativePush(doc, INITIATIVE_FIELDS, ctx);
      remote = this.check(
        await client.createInitiative({ ...input, name: doc.meta.title })
      );
    } else if (entity === 'project') {
      ops = PROJECT_OPS as unknown as EntityOps<RemoteRecord>;
      const plan = projectPush(doc, PROJECT_FIELDS, null, ctx);
      const created = this.check(
        await client.createProject({
          ...plan.input,
          name: doc.meta.title,
          teamIds: [teamId],
        })
      );
      remote = created;
      if (created !== null) {
        const members = projectPush(doc, ['initiatives'], created, ctx);
        let ok = true;
        try {
          for (const initiativeId of members.link) {
            if (
              this.check(
                await client.linkProjectInitiative(created.id, initiativeId)
              ) === null
            ) {
              ok = false;
            }
          }
        } catch (err) {
          halt = haltOf(err);
          ok = false;
        }
        if (ok)
          assumed = { initiatives: taskProjectValues(doc, ctx).initiatives };
        else failed.add('initiatives');
      }
    } else if (entity === 'milestone') {
      ops = MILESTONE_OPS as unknown as EntityOps<RemoteRecord>;
      const input = milestonePush(doc, MILESTONE_FIELDS, ctx);
      remote = this.check(
        await client.createMilestone({
          ...input,
          name: doc.meta.title,
          projectId: input.projectId ?? projectAbove(doc, ctx) ?? '',
        })
      );
    } else {
      ops = ISSUE_OPS as unknown as EntityOps<RemoteRecord>;
      const team = this.teamForNewIssue(doc);
      if (!(await this.ensureLabels(doc, team))) failed.add('labels');
      const plan = issuePush(doc, ISSUE_FIELDS, null, ctx, team);
      // A create leaves unset fields out rather than sending explicit nulls.
      const input = Object.fromEntries(
        Object.entries(plan.input).filter(([, v]) => v !== null)
      );
      const created = this.check(
        await client.createIssue({
          ...input,
          teamId: team,
          title: doc.meta.title,
        })
      );
      remote = created;
      if (created !== null) {
        const follow = issuePush(doc, ISSUE_FOLLOW_UP_FIELDS, created, ctx);
        // An archive the task's own fields do not ask for (a finished task's,
        // see taskIssueValues) is never resent from the base.
        const arrival = opts?.archive === true && follow.archive !== true;
        try {
          assumed = await this.followUps(doc, created, follow, failed);
          if (follow.archive === true || arrival) {
            const archived = this.check(await client.archiveIssue(created.id));
            if (archived === null) failed.add('archived');
            else remote = archived;
          }
        } catch (err) {
          halt = haltOf(err);
          assumed = {};
          for (const field of ISSUE_FOLLOW_UP_FIELDS) failed.add(field);
        }
        if (arrival && failed.has('archived')) {
          (this.d.state.pendingArchives ??= {})[doc.meta.id] = created.id;
        }
      }
    }
    if (remote === null) {
      return {
        created: false,
        error: this.lastFailure ?? 'Linear did not create the record',
        capped: this.capped,
      };
    }
    // Recording the link is bookkeeping, not an edit, so `updated` is kept.
    const current = this.d.store.get(doc.meta.id) ?? doc;
    // A milestone made unordered takes the order Linear gave it, unless one
    // was set here during the round-trip.
    const order =
      entity === 'milestone' &&
      doc.meta.sortOrder === null &&
      current.meta.sortOrder === null
        ? (remote as LinearProjectMilestone).sortOrder
        : undefined;
    const linked = this.write(
      doc.meta.id,
      {
        external: linearExternal({ entity, id: remote.id }),
        ...(order === undefined ? {} : { sortOrder: order }),
      },
      current.meta.updated
    );
    const sent =
      order === undefined
        ? doc
        : { ...doc, meta: { ...doc.meta, sortOrder: order } };
    // The local side is what was sent, so an edit made mid-round-trip reads as
    // a change; a failed field is based on Linear's value, so it is resent.
    const base = nextBase(
      ops.fields,
      ops.local(sent, ctx),
      { ...ops.remote(remote, ctx), ...assumed },
      null
    );
    for (const field of failed) {
      const hash = base.remote[field];
      if (hash !== undefined) base.local[field] = hash;
    }
    writeBase(this.d.state, linked.meta.id, entity, ops.fields, base);
    if (failed.size === 0) this.d.state.pushed[doc.meta.id] = version;
    this.recordEcho(remote.id, remote.updatedAt);
    this.recordChip(remote);
    summary.createdIssues++;
    summary.pushed++;
    if (halt !== null) throw halt;
    return { created: true };
  }

  /** Archives an issue an export created to arrive archived, whose archive
   *  did not land then; answers whether it landed now. */
  async archiveOnArrival(taskId: string, issueId: string): Promise<boolean> {
    const archived = this.check(await this.d.client.archiveIssue(issueId));
    if (archived === null) return false;
    // Recorded as Linear's side only, as the create would have.
    const base = readBase(this.d.state, taskId, 'issue');
    if (base !== null) {
      base.remote.archived = fieldHash(true);
      writeBase(this.d.state, taskId, 'issue', ISSUE_FIELDS, base);
    }
    this.recordEcho(archived.id, archived.updatedAt);
    return true;
  }

  // A new issue joins its parent issue's team when that is a linked one (a
  // sub-issue stays beside its parent), else the primary team.
  private teamForNewIssue(doc: TaskDoc): string {
    const parent = parseLinearExternal(
      this.d.ctx.tasks.get(doc.meta.parent ?? '')?.external
    );
    if (parent?.entity !== 'issue') return this.d.teamId;
    return (
      linkedIssueTeam(this.d.state, this.d.teamByKey, parent.id) ??
      this.d.teamId
    );
  }

  /**
   * An issue that left every linked team: the task is unlinked (and
   * remembered, so it is linked again if the issue comes back to one) rather
   * than following a team whose workflow this project does not mirror. A move
   * between linked teams is followed instead, as an ordinary state change.
   */
  unlinkMoved(doc: TaskDoc, issueId: string, where: string): void {
    this.d.state.movedOut[issueId] = doc.meta.id;
    delete this.d.state.bases[doc.meta.id];
    this.write(
      doc.meta.id,
      {
        external: null,
        appendActivity: `Unlinked from Linear: the issue moved to ${where}, outside the linked teams`,
        activityActor: 'none',
      },
      doc.meta.updated
    );
  }

  /** Links a task back to an issue that returned to a linked team. */
  relink(taskId: string, issue: LinearIssue): TaskDoc | null {
    const doc = this.d.docs.get(taskId);
    if (doc === undefined || doc.meta.external !== null) return null;
    delete this.d.state.movedOut[issue.id];
    return this.write(
      taskId,
      {
        external: linearExternal({ entity: 'issue', id: issue.id }),
        appendActivity: `Relinked to Linear ${issue.identifier}: the issue is back in a linked team`,
        activityActor: 'none',
      },
      doc.meta.updated
    );
  }

  /** A record deleted in Linear: the task is archived and unlinked, never deleted. */
  unlinkDeleted(doc: TaskDoc): void {
    delete this.d.state.bases[doc.meta.id];
    this.write(
      doc.meta.id,
      {
        external: null,
        archivedAt: doc.meta.archivedAt ?? new Date().toISOString(),
        appendActivity: 'Unlinked from Linear: the record was deleted there',
        activityActor: 'none',
      },
      doc.meta.updated
    );
  }
}

interface PushResult<R> {
  remote: R;
  failed: Set<string>;
  /** Values assumed to hold remotely after writes no refetch confirmed. */
  assumed: FieldValues;
}
