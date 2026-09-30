import { labelRef } from './labels.js';
import type {
  LinearIssue,
  LinearIssueInput,
  LinearLabel,
  LinearProjectStatus,
  LinearRef,
  LinearTruncatedField,
  LinearWorkflowState,
} from './linearMap.js';
import {
  externalId,
  parseLinearExternal,
  priorityFromLinear,
  priorityToLinear,
} from './linearMap.js';
import { UNMAPPED } from './linearMerge.js';
import type { PeopleIndex } from './linearPeople.js';
import { statusTypeOfState } from './linearStatuses.js';
// Every Linear issue field, both directions, as canonical per-field values the
// three-way merge compares (linearMerge.ts). Pure: no node:* imports.
import { canonicalAssignee, UNRESOLVED_LINEAR_ASSIGNEE } from './people.js';
import type { StatusModel } from './status.js';
import { isDoneStatus, statusesOfType, statusType } from './status.js';
import type { CreateInput, UpdatePatch } from './store.js';
import {
  escapeHeadingLines,
  getSection,
  splitSections,
  unescapeHeadingLines,
} from './taskfile.js';
import type { TaskDoc, TaskMeta } from './types.js';

export const ISSUE_FIELDS = [
  'title',
  'description',
  'state',
  'priority',
  'estimate',
  'assignee',
  'labels',
  'dueDate',
  'cycle',
  'parent',
  'project',
  'milestone',
  'blockedBy',
  'relatedTo',
  'duplicateOf',
  'archived',
  'links',
  'creator',
] as const;
export type IssueField = (typeof ISSUE_FIELDS)[number];

/** Linear owns these: set on import, never pushed. */
export const PULL_ONLY_ISSUE_FIELDS: ReadonlySet<string> = new Set(['creator']);

/** Body sections Linear never sees: the run log and the attachments list. */
const ACTIVITY = 'Activity';
const LINKS = 'Links';
const DESCRIPTION = 'Description';
const ACCEPTANCE = 'Acceptance Criteria';

/** Everything a mapping needs besides the two records themselves. */
export interface LinearMapContext {
  /** Every local task, for ancestor walks and link lookups. */
  tasks: ReadonlyMap<string, TaskMeta>;
  /** Linear record id (any kind) -> the task linked to it. */
  taskByRemote: ReadonlyMap<string, string>;
  /** Workflow state id (any linked team's) -> generated status name. */
  statusByState: ReadonlyMap<string, string>;
  /** Each linked team's workflow states, by team id. */
  teamStates: ReadonlyMap<string, readonly LinearWorkflowState[]>;
  /** The team a new issue goes to when nothing picks another. */
  defaultTeamId: string;
  model: StatusModel;
  people: PeopleIndex;
  /** Known labels by lowercased label key (see labelKey): every label that
   *  spells the key, since each linked team can have its own. */
  labels: ReadonlyMap<string, readonly LinearLabel[]>;
  /** Label id -> label, for resolving an issue label's group. */
  labelsById: ReadonlyMap<string, LinearLabel>;
  /** Whether Acceptance Criteria travels in the Linear description. */
  includeAcceptanceCriteria: boolean;
  projectStatuses: readonly LinearProjectStatus[];
}

/** A label as a task spells it: `Group/Name` inside a group, else the name. */
export function labelKey(label: LinearLabel): string {
  return labelRef(label);
}

/**
 * The label a task's `key` names on an issue in `teamId`: the team's own,
 * else a workspace label, else none (Linear rejects another team's label).
 */
export function labelFor(
  key: string,
  teamId: string,
  ctx: LinearMapContext
): LinearLabel | undefined {
  const candidates = ctx.labels.get(key.toLowerCase()) ?? [];
  return (
    candidates.find((l) => l.teamId === teamId) ??
    candidates.find((l) => l.teamId == null)
  );
}

/**
 * The workflow state a status means on an issue in `teamId`: the team's state
 * generated as that status, else the team's first state of the status's type
 * (a status another linked team's workflow brought), else null.
 */
export function stateIdFor(
  teamId: string,
  status: string,
  ctx: LinearMapContext
): string | null {
  const states = ctx.teamStates.get(teamId) ?? [];
  const named = states.find((s) => ctx.statusByState.get(s.id) === status);
  if (named !== undefined) return named.id;
  const type = statusType(status, ctx.model);
  const ofType = states
    .filter((s) => statusTypeOfState(s.type) === type)
    .sort((a, b) => {
      // A state of exactly that type before a `duplicate` standing in for it.
      const exact = Number(a.type !== type) - Number(b.type !== type);
      return exact !== 0 ? exact : (a.position ?? 0) - (b.position ?? 0);
    });
  return ofType[0]?.id ?? null;
}

// The statuses the linked workflows generated, memoized per context map.
const generatedStatuses = new WeakMap<
  ReadonlyMap<string, string>,
  ReadonlySet<string>
>();

function isGeneratedStatus(status: string, ctx: LinearMapContext): boolean {
  let known = generatedStatuses.get(ctx.statusByState);
  if (known === undefined) {
    known = new Set(ctx.statusByState.values());
    generatedStatuses.set(ctx.statusByState, known);
  }
  return known.has(status);
}

// ---------------------------------------------------------------------------
// Description <-> body

/** Markdown in the form both sides are compared in. */
export function normalizeMarkdown(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface Section {
  heading: string;
  content: string;
}

// A body's sections with their content unescaped and trimmed.
function bodySections(body: string): { preamble: string; sections: Section[] } {
  const { preamble, sections } = splitSections(body);
  return {
    preamble,
    sections: sections.map((s) => ({
      heading: s.heading,
      content: unescapeHeadingLines(s.content.trim()),
    })),
  };
}

const FENCE = /^\s*(```|~~~)/;

// Splits Linear markdown on `## ` headings the way a task body is split, except
// that a Dispatch-only heading, or one inside a code fence, stays as text.
function markdownSections(
  md: string,
  includeAc: boolean
): { lead: string; sections: Section[] } {
  const lines = normalizeMarkdown(md).split('\n');
  const lead: string[] = [];
  const sections: { heading: string; lines: string[] }[] = [];
  let fenced = false;
  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? undefined : /^## (.+)$/.exec(line)?.[1].trim();
    if (
      heading !== undefined &&
      heading !== '' &&
      !isLocalOnly(heading, includeAc)
    ) {
      sections.push({ heading, lines: [] });
      continue;
    }
    const current = sections[sections.length - 1];
    if (current === undefined) lead.push(line);
    else current.lines.push(line);
  }
  return {
    lead: lead.join('\n').trim(),
    sections: sections.map((s) => ({
      heading: s.heading,
      content: s.lines.join('\n').trim(),
    })),
  };
}

// Lead text then `## ` blocks, one blank line apart: the single spelling both
// sides are compared (and pushed) in.
function renderMarkdown(lead: string, sections: readonly Section[]): string {
  const parts = lead === '' ? [] : [lead];
  for (const s of sections) {
    parts.push(
      s.content === '' ? `## ${s.heading}` : `## ${s.heading}\n\n${s.content}`
    );
  }
  return parts.join('\n\n');
}

/** A Linear description in the canonical form a task body publishes. */
export function canonicalMarkdown(md: string, includeAc: boolean): string {
  const { lead, sections } = markdownSections(md, includeAc);
  return renderMarkdown(lead, sections);
}

// Headings that belong to Dispatch: never pushed, and a Linear description
// using one keeps it as text rather than opening a section.
function isLocalOnly(heading: string, includeAc: boolean): boolean {
  return (
    heading === ACTIVITY ||
    heading === LINKS ||
    heading === DESCRIPTION ||
    (heading === ACCEPTANCE && !includeAc)
  );
}

/**
 * The Linear description a task body publishes: its Description, then every
 * other non-empty section as a `## ` block, minus the Dispatch-only ones
 * (Activity, Links, and Acceptance Criteria unless opted in).
 */
export function linearDescriptionFromBody(
  body: string,
  includeAcceptanceCriteria: boolean
): string {
  const sections = bodySections(body).sections.filter(
    (s) =>
      !isLocalOnly(s.heading, includeAcceptanceCriteria) &&
      // An empty template heading stays local; any other one travels as-is.
      !(s.content === '' && s.heading === ACCEPTANCE)
  );
  return renderMarkdown(getSection(body, DESCRIPTION), sections);
}

function renderSections(preamble: string, sections: Section[]): string {
  return (
    preamble +
    sections
      .map((s) => {
        const content = escapeHeadingLines(s.content.trim());
        return `## ${s.heading}${content === '' ? '\n\n' : `\n\n${content}\n\n`}`;
      })
      .join('')
  );
}

/**
 * A task body carrying a Linear description: its lead text becomes the
 * Description, its `## ` blocks become sections in its order, and the
 * Dispatch-only sections keep their local content after them. A synced
 * section Linear no longer has is dropped; Acceptance Criteria is emptied
 * instead, since every task carries that heading.
 */
export function bodyWithLinearDescription(
  body: string,
  markdown: string,
  includeAcceptanceCriteria: boolean
): string {
  const local = bodySections(body);
  const remote = markdownSections(markdown, includeAcceptanceCriteria);
  const sections: Section[] = [
    { heading: DESCRIPTION, content: remote.lead },
    ...remote.sections,
  ];
  const has = (heading: string) => sections.some((s) => s.heading === heading);
  if (!has(ACCEPTANCE)) {
    const localAc = local.sections.find((s) => s.heading === ACCEPTANCE);
    sections.push({
      heading: ACCEPTANCE,
      content: includeAcceptanceCriteria ? '' : (localAc?.content ?? ''),
    });
  }
  for (const heading of [LINKS, ACTIVITY]) {
    const kept = local.sections.find((s) => s.heading === heading);
    if (kept !== undefined) sections.push(kept);
    else if (heading === ACTIVITY) sections.push({ heading, content: '' });
  }
  return renderSections(local.preamble, sections);
}

// ---------------------------------------------------------------------------
// Links section <-> attachments

export interface LinkEntry {
  url: string;
  title: string;
}

const LINK_LINE = /^\s*[-*]\s+(?:\[(.*)\]\((\S+)\)|<?(https?:\/\/\S+?)>?)\s*$/;

/** The `## Links` section's entries. */
export function linksFromBody(body: string): LinkEntry[] {
  const out: LinkEntry[] = [];
  for (const line of getSection(body, LINKS).split('\n')) {
    const m = LINK_LINE.exec(line);
    if (m === null) continue;
    const url = m[2] ?? m[3];
    if (url === undefined) continue;
    out.push({ url, title: m[1] ?? url });
  }
  return out;
}

function canonicalLinks(links: readonly LinkEntry[]): LinkEntry[] {
  const byUrl = new Map<string, LinkEntry>();
  for (const l of links) {
    const title = l.title.trim();
    byUrl.set(l.url, { url: l.url, title: title === '' ? l.url : title });
  }
  return [...byUrl.values()].sort((a, b) =>
    a.url < b.url ? -1 : a.url > b.url ? 1 : 0
  );
}

/** A body with its `## Links` section replaced (removed when empty). */
export function bodyWithLinks(
  body: string,
  links: readonly LinkEntry[]
): string {
  const local = bodySections(body);
  const rest = local.sections.filter((s) => s.heading !== LINKS);
  if (links.length === 0) return renderSections(local.preamble, rest);
  const content = links
    .map((l) => `- [${l.title.replace(/[[\]]/g, '')}](${l.url})`)
    .join('\n');
  const activity = rest.findIndex((s) => s.heading === ACTIVITY);
  const at = activity < 0 ? rest.length : activity;
  rest.splice(at, 0, { heading: LINKS, content });
  return renderSections(local.preamble, rest);
}

// ---------------------------------------------------------------------------
// Hierarchy helpers

/** A task's Linear link, if it has one. */
export function linkOf(meta: TaskMeta | undefined): LinearRef | null {
  return meta === undefined ? null : parseLinearExternal(meta.external);
}

// The nearest linked project and milestone above a task, walking parents.
function ancestry(
  meta: TaskMeta,
  ctx: LinearMapContext
): { project: string | null; milestone: string | null } {
  let project: string | null = null;
  let milestone: string | null = null;
  const seen = new Set<string>([meta.id]);
  let cursor = meta.parent;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = ctx.tasks.get(cursor);
    if (parent === undefined) break;
    const ref = linkOf(parent);
    if (ref?.entity === 'milestone' && milestone === null) milestone = ref.id;
    if (ref?.entity === 'project') {
      project = ref.id;
      break;
    }
    if (ref?.entity === 'initiative') break;
    cursor = parent.parent;
  }
  return { project, milestone };
}

// A local task id as the id of the Linear record of `entity` it is linked to.
function remoteIdOf(
  taskId: string | null,
  entity: LinearRef['entity'],
  ctx: LinearMapContext
): string | null {
  if (taskId === null) return null;
  const ref = linkOf(ctx.tasks.get(taskId));
  return ref?.entity === entity ? ref.id : null;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

// Local task ids linked to Linear issues, as issue ids.
function issueIds(taskIds: readonly string[], ctx: LinearMapContext): string[] {
  return sortedUnique(
    taskIds.flatMap((id) => {
      const remote = remoteIdOf(id, 'issue', ctx);
      return remote === null ? [] : [remote];
    })
  );
}

// Linear ids as local task ids, keeping the entries that were never linked
// (local-only structure Linear cannot see).
function localIds(
  remoteIds: readonly string[],
  current: readonly string[],
  ctx: LinearMapContext
): string[] {
  const mapped = remoteIds.flatMap((id) => {
    const task = ctx.taskByRemote.get(id);
    return task === undefined ? [] : [task];
  });
  const unlinked = current.filter(
    (id) => linkOf(ctx.tasks.get(id))?.entity !== 'issue'
  );
  return [...new Set([...mapped, ...unlinked])];
}

// ---------------------------------------------------------------------------
// Issue projections

export type IssueValues = Record<IssueField, unknown>;

/** The fields a fetch cut short, which the merge must not trust this pass. */
export function untrustedIssueFields(
  truncated: readonly LinearTruncatedField[]
): Set<string> {
  const out = new Set<string>();
  if (truncated.includes('labels')) out.add('labels');
  if (truncated.includes('attachments')) out.add('links');
  if (truncated.includes('relations')) {
    out.add('blockedBy');
    out.add('relatedTo');
    out.add('duplicateOf');
  }
  return out;
}

// An issue's state as the status it generated: statuses are one vocabulary
// across the linked teams, so an issue moving between two of them does not
// read as a state change. A state no generation named stays distinct.
function remoteStatus(
  issue: LinearIssue,
  ctx: LinearMapContext
): string | null {
  if (issue.state === null) return null;
  return (
    ctx.statusByState.get(issue.state.id) ?? `\u0000state:${issue.state.id}`
  );
}

/** A Linear issue's canonical values. */
export function issueValues(
  issue: LinearIssue,
  ctx: LinearMapContext
): IssueValues {
  const labels = issue.labels.map((l) =>
    labelKey(ctx.labelsById.get(l.id) ?? l).toLowerCase()
  );
  const rel = issue.relations;
  return {
    title: issue.title,
    description: canonicalMarkdown(
      issue.description ?? '',
      ctx.includeAcceptanceCriteria
    ),
    state: remoteStatus(issue, ctx),
    priority: issue.priority,
    estimate: issue.estimate,
    assignee: issue.assigneeId,
    labels: sortedUnique(labels),
    dueDate: issue.dueDate,
    cycle: issue.cycle?.id ?? null,
    parent: issue.parentId,
    project: issue.projectId,
    milestone: issue.projectMilestoneId,
    blockedBy: sortedUnique(
      rel
        .filter((r) => r.type === 'blocks' && r.relatedIssueId === issue.id)
        .map((r) => r.issueId)
    ),
    relatedTo: sortedUnique(
      rel
        .filter((r) => r.type === 'related')
        .map((r) => (r.issueId === issue.id ? r.relatedIssueId : r.issueId))
        .filter((id) => id !== issue.id)
    ),
    duplicateOf:
      rel.find((r) => r.type === 'duplicate' && r.issueId === issue.id)
        ?.relatedIssueId ?? null,
    archived: issue.archivedAt !== null,
    links: canonicalLinks(issue.attachments),
    creator: issue.creatorId,
  };
}

/** A task's person ref as a Linear user id; UNMAPPED for an agent or a stranger. */
export function linearUserOf(
  ref: string | null,
  ctx: LinearMapContext
): unknown {
  if (ref === null || ref === 'none') return null;
  const canonical = canonicalAssignee(ref, ctx.people.localRef);
  return ctx.people.userByRef.get(canonical) ?? UNMAPPED;
}

/** A task's canonical values, in the same space as `issueValues`. */
export function taskIssueValues(
  doc: TaskDoc,
  ctx: LinearMapContext
): IssueValues {
  const { meta } = doc;
  const { project, milestone } = ancestry(meta, ctx);
  const duplicate =
    meta.duplicateOf === null
      ? null
      : (remoteIdOf(meta.duplicateOf, 'issue', ctx) ?? UNMAPPED);
  // A finished task's archive is the board tidying up after itself; Linear
  // archives completed issues on its own schedule, so only an archive of live
  // work is pushed (see the report's "lossy" notes).
  const archived = isDoneStatus(meta.status, ctx.model)
    ? UNMAPPED
    : meta.archivedAt !== undefined;
  return {
    title: meta.title,
    description: linearDescriptionFromBody(
      doc.body,
      ctx.includeAcceptanceCriteria
    ),
    state: isGeneratedStatus(meta.status, ctx) ? meta.status : UNMAPPED,
    priority: priorityToLinear(meta.priority),
    estimate: meta.estimate,
    assignee: linearUserOf(meta.assignee, ctx),
    labels: sortedUnique(meta.labels.map((l) => l.toLowerCase())),
    dueDate: meta.dueDate,
    cycle: meta.cycle?.id ?? null,
    parent: remoteIdOf(meta.parent, 'issue', ctx),
    project,
    milestone,
    blockedBy: issueIds(meta.blockedBy, ctx),
    relatedTo: issueIds(meta.relatedTo, ctx),
    duplicateOf: duplicate,
    archived,
    links: canonicalLinks(linksFromBody(doc.body)),
    creator: linearUserOf(meta.creator, ctx),
  };
}

// The status a state id maps to, falling back to the first status of the
// state's type (a state generated after this context was built).
function statusFor(
  issue: LinearIssue,
  current: string,
  ctx: LinearMapContext
): string {
  if (issue.state === null) return current;
  const named = ctx.statusByState.get(issue.state.id);
  if (named !== undefined) return named;
  const type = statusTypeOfState(issue.state.type);
  if (statusType(current, ctx.model) === type) return current;
  return statusesOfType(type, ctx.model)[0] ?? ctx.model.roles.ready;
}

// A task's parent from an issue's three hierarchy references: the parent
// issue, else the milestone, else the project. A local-only parent (a
// container never linked) survives an issue that names none of them.
function parentFor(
  issue: LinearIssue,
  meta: TaskMeta | null,
  ctx: LinearMapContext
): string | null {
  for (const id of [
    issue.parentId,
    issue.projectMilestoneId,
    issue.projectId,
  ]) {
    if (id === null) continue;
    const task = ctx.taskByRemote.get(id);
    if (task !== undefined) return task;
  }
  const current = meta?.parent ?? null;
  if (current !== null && linkOf(ctx.tasks.get(current)) === null) {
    return current;
  }
  return null;
}

/**
 * Fields whose local value only stands in for Linear's and that the context
 * can now fill: an assignee pulled before the people registry could name
 * them. The merge pulls these (see MergeInput.refresh); never a local edit.
 */
export function replaceableIssueFields(
  doc: TaskDoc,
  issue: LinearIssue,
  ctx: LinearMapContext
): ReadonlySet<string> {
  const fields = new Set<string>();
  if (
    doc.meta.assignee === UNRESOLVED_LINEAR_ASSIGNEE &&
    issue.assigneeId !== null &&
    ctx.people.refByUser.has(issue.assigneeId)
  ) {
    fields.add('assignee');
  }
  return fields;
}

/** Linear's value of `field`, as the UpdatePatch that writes it locally. */
export function issuePatch(
  issue: LinearIssue,
  fields: Iterable<string>,
  doc: TaskDoc,
  ctx: LinearMapContext
): UpdatePatch {
  const patch: UpdatePatch = {};
  const { meta } = doc;
  let body = doc.body;
  let bodyChanged = false;
  let parentDone = false;
  let values: IssueValues | null = null;
  const remote = () => (values ??= issueValues(issue, ctx));
  for (const field of fields) {
    switch (field as IssueField) {
      case 'title':
        patch.title = issue.title;
        break;
      case 'description':
        body = bodyWithLinearDescription(
          body,
          issue.description ?? '',
          ctx.includeAcceptanceCriteria
        );
        bodyChanged = true;
        break;
      case 'state':
        patch.status = statusFor(issue, meta.status, ctx);
        break;
      case 'priority':
        patch.priority = priorityFromLinear(issue.priority);
        break;
      case 'estimate':
        patch.estimate = issue.estimate;
        break;
      case 'assignee':
        patch.assignee =
          issue.assigneeId === null
            ? 'none'
            : (ctx.people.refByUser.get(issue.assigneeId) ??
              UNRESOLVED_LINEAR_ASSIGNEE);
        break;
      case 'labels':
        patch.labels = [
          ...new Set(
            issue.labels.map((l) => labelKey(ctx.labelsById.get(l.id) ?? l))
          ),
        ];
        break;
      case 'dueDate':
        patch.dueDate = issue.dueDate;
        break;
      case 'cycle':
        patch.cycle = issue.cycle;
        break;
      case 'parent':
      case 'project':
      case 'milestone':
        if (!parentDone) patch.parent = parentFor(issue, meta, ctx);
        parentDone = true;
        break;
      case 'blockedBy':
        patch.blockedBy = localIds(
          remote().blockedBy as string[],
          meta.blockedBy,
          ctx
        );
        break;
      case 'relatedTo':
        patch.relatedTo = localIds(
          remote().relatedTo as string[],
          meta.relatedTo,
          ctx
        );
        break;
      case 'duplicateOf': {
        const target = remote().duplicateOf as string | null;
        patch.duplicateOf =
          target === null ? null : (ctx.taskByRemote.get(target) ?? null);
        break;
      }
      case 'archived':
        patch.archivedAt = issue.archivedAt;
        break;
      case 'links':
        body = bodyWithLinks(body, issue.attachments);
        bodyChanged = true;
        break;
      case 'creator':
        patch.creator =
          issue.creatorId === null
            ? null
            : (ctx.people.refByUser.get(issue.creatorId) ?? null);
        break;
    }
  }
  if (bodyChanged) patch.body = body;
  return patch;
}

/** A new local task for a Linear issue; the rest arrives as an issuePatch. */
export function issueTaskCreate(
  issue: LinearIssue,
  ctx: LinearMapContext
): CreateInput {
  return {
    title: issue.title,
    kind: 'task',
    status: statusFor(issue, ctx.model.roles.ready, ctx),
    priority: priorityFromLinear(issue.priority),
    external: externalId(issue),
  };
}

/** What pushing some of a task's fields asks of Linear. */
export interface IssuePush {
  /** Scalar fields for issueCreate/issueUpdate; empty when none changed. */
  input: LinearIssueInput;
  relations: {
    create: { issueId: string; relatedIssueId: string; type: string }[];
    remove: string[];
  };
  links: { add: LinkEntry[]; remove: string[] };
  /** true archives, false unarchives, null leaves it. */
  archive: boolean | null;
}

/** Local labels no Linear label usable in `teamId` spells, to create before a push. */
export function missingLabels(
  doc: TaskDoc,
  ctx: LinearMapContext,
  teamId: string = ctx.defaultTeamId
): string[] {
  return doc.meta.labels.filter((l) => labelFor(l, teamId, ctx) === undefined);
}

function setDiff(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b);
  return a.filter((x) => !other.has(x));
}

// Writes that need the issue to exist first: a create sends the scalar input,
// then these in a second push against the created issue.
export const ISSUE_FOLLOW_UP_FIELDS: readonly IssueField[] = [
  'blockedBy',
  'relatedTo',
  'duplicateOf',
  'archived',
  'links',
];

/**
 * The Linear writes that carry `fields` from a task to its issue. `remote` is
 * the issue as last fetched, which is where relation and attachment ids come
 * from; for a create it is null and only the scalar input is filled. `teamId`
 * is the issue's team, whose states and labels the push names.
 */
export function issuePush(
  doc: TaskDoc,
  fields: Iterable<string>,
  remote: LinearIssue | null,
  ctx: LinearMapContext,
  teamId: string = remote?.team?.id ?? ctx.defaultTeamId
): IssuePush {
  const local = taskIssueValues(doc, ctx);
  const was = remote === null ? null : issueValues(remote, ctx);
  const selfId = remote?.id ?? '';
  const push: IssuePush = {
    input: {},
    relations: { create: [], remove: [] },
    links: { add: [], remove: [] },
    archive: null,
  };
  const input = push.input;
  const rel = remote?.relations ?? [];
  for (const field of fields) {
    const value = local[field as IssueField];
    if (value === UNMAPPED || PULL_ONLY_ISSUE_FIELDS.has(field)) continue;
    if (
      remote === null &&
      ISSUE_FOLLOW_UP_FIELDS.includes(field as IssueField)
    ) {
      continue;
    }
    switch (field as IssueField) {
      case 'title':
        input.title = value as string;
        break;
      case 'description':
        input.description = value as string;
        break;
      case 'state': {
        const stateId = stateIdFor(teamId, value as string, ctx);
        if (stateId !== null) input.stateId = stateId;
        break;
      }
      case 'priority':
        input.priority = value as number;
        break;
      case 'estimate':
        input.estimate = value === null ? null : Math.round(value as number);
        break;
      case 'assignee':
        input.assigneeId = value as string | null;
        break;
      case 'labels':
        input.labelIds = sortedUnique(
          doc.meta.labels.flatMap((l) => {
            const label = labelFor(l, teamId, ctx);
            return label === undefined ? [] : [label.id];
          })
        );
        break;
      case 'dueDate':
        input.dueDate = value as string | null;
        break;
      case 'cycle':
        input.cycleId = value as string | null;
        break;
      case 'parent':
        input.parentId = value as string | null;
        break;
      case 'project':
        input.projectId = value as string | null;
        break;
      case 'milestone':
        input.projectMilestoneId = value as string | null;
        break;
      case 'blockedBy': {
        const now = value as string[];
        const before = (was?.blockedBy ?? []) as string[];
        for (const blocker of setDiff(now, before)) {
          push.relations.create.push({
            issueId: blocker,
            relatedIssueId: selfId,
            type: 'blocks',
          });
        }
        const gone = new Set(setDiff(before, now));
        for (const r of rel) {
          if (
            r.type === 'blocks' &&
            r.relatedIssueId === selfId &&
            gone.has(r.issueId)
          ) {
            push.relations.remove.push(r.id);
          }
        }
        break;
      }
      case 'relatedTo': {
        const now = value as string[];
        const before = (was?.relatedTo ?? []) as string[];
        for (const other of setDiff(now, before)) {
          push.relations.create.push({
            issueId: selfId,
            relatedIssueId: other,
            type: 'related',
          });
        }
        const gone = new Set(setDiff(before, now));
        for (const r of rel) {
          if (r.type !== 'related') continue;
          const other = r.issueId === selfId ? r.relatedIssueId : r.issueId;
          if (gone.has(other)) push.relations.remove.push(r.id);
        }
        break;
      }
      case 'duplicateOf': {
        const target = value as string | null;
        for (const r of rel) {
          if (
            r.type === 'duplicate' &&
            r.issueId === selfId &&
            r.relatedIssueId !== target
          ) {
            push.relations.remove.push(r.id);
          }
        }
        if (target !== null && was?.duplicateOf !== target) {
          push.relations.create.push({
            issueId: selfId,
            relatedIssueId: target,
            type: 'duplicate',
          });
        }
        break;
      }
      case 'archived':
        push.archive = value as boolean;
        break;
      case 'links': {
        const now = value as LinkEntry[];
        const before = new Map(
          (remote?.attachments ?? []).map((a) => [a.url, a])
        );
        const wanted = new Set(now.map((l) => l.url));
        for (const l of now) {
          const had = before.get(l.url);
          if (had === undefined || had.title !== l.title)
            push.links.add.push(l);
        }
        for (const [url, a] of before) {
          if (!wanted.has(url)) push.links.remove.push(a.id);
        }
        break;
      }
      case 'creator':
        break;
    }
  }
  return push;
}
