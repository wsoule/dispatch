// Linear's containers — initiatives, projects, project milestones — as
// container tasks, field by field in both directions, in the same canonical
// space the issue mapping uses. Pure: no node:* imports.
import type { LinearMapContext } from './linearFields.js';
import {
  bodyWithLinearDescription,
  canonicalMarkdown,
  linearDescriptionFromBody,
  linearUserOf,
  linkOf,
} from './linearFields.js';
import type {
  LinearInitiative,
  LinearInitiativeInput,
  LinearMilestoneInput,
  LinearProject,
  LinearProjectInput,
  LinearProjectMilestone,
} from './linearMap.js';
import {
  linearExternal,
  priorityFromLinear,
  priorityToLinear,
} from './linearMap.js';
import { UNMAPPED } from './linearMerge.js';
import type { StatusType } from './status.js';
import { statusesOfType, statusType } from './status.js';
import type { CreateInput, UpdatePatch } from './store.js';
import type { TaskDoc, TaskMeta } from './types.js';

type Values = Record<string, unknown>;

export const PROJECT_FIELDS = [
  'title',
  'description',
  'status',
  'priority',
  'lead',
  'startDate',
  'targetDate',
  'color',
  'icon',
  'initiatives',
  'archived',
] as const;

export const MILESTONE_FIELDS = [
  'title',
  'description',
  'targetDate',
  'project',
  'archived',
  'sortOrder',
] as const;

export const INITIATIVE_FIELDS = [
  'title',
  'description',
  'status',
  'owner',
  'targetDate',
  'color',
  'icon',
  'archived',
] as const;

/** Container archives follow Linear; pushing one would trash the record. */
export const PULL_ONLY_CONTAINER_FIELDS: ReadonlySet<string> = new Set([
  'archived',
]);

// A container's status: Linear's project and initiative statuses are their own
// vocabularies, so a status compares by name where both sides spell it (a team
// state and a project status both called "In Progress", or a "Paused" state
// for a paused project), else by category. A name only matches inside one
// open/completed/canceled class, so no mapping changes whether a container
// counts as done, which is all blocking and fan-out read of it.
function localCategory(status: string, ctx: LinearMapContext): StatusType {
  const type = statusType(status, ctx.model);
  return type === 'triage' ? 'backlog' : type;
}

function doneClass(type: StatusType): 'open' | 'completed' | 'canceled' {
  return type === 'completed' || type === 'canceled' ? type : 'open';
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

// The merge value of a status name both vocabularies spell.
function namedValue(name: string): string {
  return `=${nameKey(name)}`;
}

// The local status spelled like a Linear status of `category`, if any.
function localStatusNamed(
  name: string,
  category: StatusType,
  ctx: LinearMapContext
): string | undefined {
  return ctx.model.definitions.find(
    (d) =>
      nameKey(d.name) === nameKey(name) &&
      doneClass(d.type) === doneClass(category)
  )?.name;
}

// A Linear status's merge value: its name when a local status spells it, else
// its category.
function remoteStatusValue(
  name: string | null,
  category: StatusType,
  ctx: LinearMapContext
): string {
  return name !== null && localStatusNamed(name, category, ctx) !== undefined
    ? namedValue(name)
    : category;
}

// A local status's merge value against Linear's `names` (each with its
// category): its name when Linear spells it, else its category.
function localStatusValue(
  status: string,
  names: readonly (readonly [string, StatusType])[],
  ctx: LinearMapContext
): string {
  const category = localCategory(status, ctx);
  const spelled = names.some(
    ([name, of]) =>
      nameKey(name) === nameKey(status) && doneClass(of) === doneClass(category)
  );
  return spelled ? namedValue(status) : category;
}

// The local status a Linear status pulls to: the one spelling its name, else
// the current one when it is already of the category, else the category's
// first.
function statusFromRemote(
  name: string | null,
  category: StatusType,
  current: string,
  ctx: LinearMapContext
): string {
  const spelled =
    name === null ? undefined : localStatusNamed(name, category, ctx);
  return spelled ?? statusForCategory(category, current, ctx);
}

const PROJECT_TYPE_CATEGORY: Record<string, StatusType> = {
  backlog: 'backlog',
  planned: 'unstarted',
  started: 'started',
  paused: 'started',
  completed: 'completed',
  canceled: 'canceled',
};

const INITIATIVE_CATEGORY: Record<string, StatusType> = {
  Proposed: 'backlog',
  Planned: 'unstarted',
  Active: 'started',
  Completed: 'completed',
  Canceled: 'canceled',
};

const INITIATIVE_NAMES = Object.entries(INITIATIVE_CATEGORY);

// A project status's category; a project with none reads as backlog.
function projectCategory(p: LinearProject): StatusType {
  return PROJECT_TYPE_CATEGORY[p.status?.type ?? ''] ?? 'backlog';
}

function initiativeCategory(i: LinearInitiative): StatusType {
  return INITIATIVE_CATEGORY[i.status] ?? 'unstarted';
}

const CATEGORY_INITIATIVE: Record<StatusType, string> = {
  triage: 'Planned',
  backlog: 'Planned',
  unstarted: 'Planned',
  started: 'Active',
  completed: 'Completed',
  canceled: 'Canceled',
};

// The local status for a container category: the current one when it already
// has that type, else the first status of the type.
function statusForCategory(
  category: StatusType,
  current: string,
  ctx: LinearMapContext
): string {
  if (localCategory(current, ctx) === category) return current;
  return statusesOfType(category, ctx.model)[0] ?? ctx.model.roles.ready;
}

function refOf(userId: string | null, ctx: LinearMapContext): string {
  return userId === null
    ? 'none'
    : (ctx.people.refByUser.get(userId) ?? 'none');
}

// The long markdown, falling back to the short summary when there is none.
function longText(
  content: string | null,
  summary: string | null,
  ctx: LinearMapContext
): string {
  const body = content ?? '';
  return canonicalMarkdown(
    body.trim() === '' ? (summary ?? '') : body,
    ctx.includeAcceptanceCriteria
  );
}

function description(doc: TaskDoc, ctx: LinearMapContext): string {
  return linearDescriptionFromBody(doc.body, ctx.includeAcceptanceCriteria);
}

function withDescription(
  doc: TaskDoc,
  markdown: string,
  ctx: LinearMapContext
): string {
  return bodyWithLinearDescription(
    doc.body,
    markdown,
    ctx.includeAcceptanceCriteria
  );
}

// A local-only parent (never linked) survives a remote with no parent to give.
function keepUnlinked(meta: TaskMeta, ctx: LinearMapContext): string | null {
  const current = meta.parent;
  return current !== null && linkOf(ctx.tasks.get(current)) === null
    ? current
    : null;
}

// The nearest linked project above a task.
function projectAbove(meta: TaskMeta, ctx: LinearMapContext): string | null {
  const seen = new Set<string>([meta.id]);
  let cursor = meta.parent;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = ctx.tasks.get(cursor);
    const ref = linkOf(parent);
    if (ref?.entity === 'project') return ref.id;
    cursor = parent?.parent ?? null;
  }
  return null;
}

// A project's initiatives as local ids: `parent` plus `initiatives`.
function localInitiatives(meta: TaskMeta, ctx: LinearMapContext): string[] {
  const ids = [meta.parent, ...meta.initiatives].flatMap((id) => {
    if (id === null) return [];
    const ref = linkOf(ctx.tasks.get(id));
    return ref?.entity === 'initiative' ? [ref.id] : [];
  });
  return [...new Set(ids)].sort();
}

// ---------------------------------------------------------------------------
// Projects

export function projectValues(p: LinearProject, ctx: LinearMapContext): Values {
  return {
    title: p.name,
    description: longText(p.content, p.summary, ctx),
    status: remoteStatusValue(p.status?.name ?? null, projectCategory(p), ctx),
    priority: p.priority,
    lead: p.leadId,
    startDate: p.startDate,
    targetDate: p.targetDate,
    color: p.color,
    icon: p.icon,
    initiatives: [...new Set(p.initiatives.map((i) => i.initiativeId))].sort(),
    archived: p.archivedAt !== null,
  };
}

export function taskProjectValues(doc: TaskDoc, ctx: LinearMapContext): Values {
  const { meta } = doc;
  return {
    title: meta.title,
    description: description(doc, ctx),
    status: localStatusValue(
      meta.status,
      ctx.projectStatuses.map((s) => [
        s.name,
        PROJECT_TYPE_CATEGORY[s.type] ?? 'backlog',
      ]),
      ctx
    ),
    priority: priorityToLinear(meta.priority),
    lead: linearUserOf(meta.assignee, ctx),
    startDate: meta.startDate,
    targetDate: meta.dueDate,
    color: meta.color,
    icon: meta.icon,
    initiatives: localInitiatives(meta, ctx),
    archived: meta.archivedAt !== undefined,
  };
}

export function projectPatch(
  p: LinearProject,
  fields: Iterable<string>,
  doc: TaskDoc,
  ctx: LinearMapContext
): UpdatePatch {
  const patch: UpdatePatch = {};
  const v = projectValues(p, ctx);
  for (const field of fields) {
    switch (field) {
      case 'title':
        patch.title = p.name;
        break;
      case 'description':
        patch.body = withDescription(doc, v.description as string, ctx);
        break;
      case 'status':
        patch.status = statusFromRemote(
          p.status?.name ?? null,
          projectCategory(p),
          doc.meta.status,
          ctx
        );
        break;
      case 'priority':
        patch.priority = priorityFromLinear(p.priority);
        break;
      case 'lead':
        patch.assignee = refOf(p.leadId, ctx);
        break;
      case 'startDate':
        patch.startDate = p.startDate;
        break;
      case 'targetDate':
        patch.dueDate = p.targetDate;
        break;
      case 'color':
        patch.color = p.color;
        break;
      case 'icon':
        patch.icon = p.icon;
        break;
      case 'initiatives': {
        // Linear's order: the first initiative is the parent, the rest extra.
        const mapped = p.initiatives.flatMap((i) => {
          const task = ctx.taskByRemote.get(i.initiativeId);
          return task === undefined ? [] : [task];
        });
        const unique = [...new Set(mapped)];
        patch.parent = unique[0] ?? keepUnlinked(doc.meta, ctx);
        patch.initiatives = unique.slice(1);
        break;
      }
      case 'archived':
        patch.archivedAt = p.archivedAt;
        break;
    }
  }
  return patch;
}

// Linear's project status for a category: planned for unstarted, and never
// paused — pausing is a Linear-side choice a local status cannot express.
function projectStatusId(
  category: StatusType,
  ctx: LinearMapContext
): string | undefined {
  const wanted =
    category === 'unstarted'
      ? 'planned'
      : category === 'triage'
        ? 'backlog'
        : category;
  return ctx.projectStatuses.find((s) => s.type === wanted)?.id;
}

/** What pushing some of a project's fields asks of Linear. */
export interface ProjectPush {
  input: LinearProjectInput;
  /** Initiative ids to add the project to. */
  link: string[];
  /** Membership row ids to remove. */
  unlink: string[];
}

export function projectPush(
  doc: TaskDoc,
  fields: Iterable<string>,
  remote: LinearProject | null,
  ctx: LinearMapContext
): ProjectPush {
  const v = taskProjectValues(doc, ctx);
  const out: ProjectPush = { input: {}, link: [], unlink: [] };
  const input = out.input;
  for (const field of fields) {
    const value = v[field];
    if (value === UNMAPPED || PULL_ONLY_CONTAINER_FIELDS.has(field)) continue;
    switch (field) {
      case 'title':
        input.name = value as string;
        break;
      case 'description':
        input.content = value as string;
        break;
      case 'status': {
        const wanted = doneClass(localCategory(doc.meta.status, ctx));
        const spelled = ctx.projectStatuses.find(
          (s) =>
            namedValue(s.name) === value &&
            doneClass(PROJECT_TYPE_CATEGORY[s.type] ?? 'backlog') === wanted
        );
        const id = spelled?.id ?? projectStatusId(value as StatusType, ctx);
        if (id !== undefined) input.statusId = id;
        break;
      }
      case 'priority':
        input.priority = value as number;
        break;
      case 'lead':
        input.leadId = value as string | null;
        break;
      case 'startDate':
        input.startDate = value as string | null;
        break;
      case 'targetDate':
        input.targetDate = value as string | null;
        break;
      case 'color':
        // Linear requires a project color; clearing one locally keeps theirs.
        if (value !== null) input.color = value as string;
        break;
      case 'icon':
        input.icon = value as string | null;
        break;
      case 'initiatives': {
        if (remote === null) break;
        const wanted = new Set(value as string[]);
        const have = new Set(remote.initiatives.map((i) => i.initiativeId));
        out.link = [...wanted].filter((id) => !have.has(id));
        out.unlink = remote.initiatives
          .filter((i) => !wanted.has(i.initiativeId))
          .map((i) => i.id);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Project milestones

export function milestoneValues(
  m: LinearProjectMilestone,
  ctx: LinearMapContext
): Values {
  return {
    title: m.name,
    description: canonicalMarkdown(
      m.description ?? '',
      ctx.includeAcceptanceCriteria
    ),
    targetDate: m.targetDate,
    project: m.projectId,
    archived: m.archivedAt !== null,
    sortOrder: m.sortOrder,
  };
}

export function taskMilestoneValues(
  doc: TaskDoc,
  ctx: LinearMapContext
): Values {
  const { meta } = doc;
  return {
    title: meta.title,
    description: description(doc, ctx),
    targetDate: meta.dueDate,
    project: projectAbove(meta, ctx),
    archived: meta.archivedAt !== undefined,
    // Unordered locally is never sent; a milestone made here takes the order
    // Linear gives it on creation (see createRemote).
    sortOrder: meta.sortOrder ?? UNMAPPED,
  };
}

export function milestonePatch(
  m: LinearProjectMilestone,
  fields: Iterable<string>,
  doc: TaskDoc,
  ctx: LinearMapContext
): UpdatePatch {
  const patch: UpdatePatch = {};
  for (const field of fields) {
    switch (field) {
      case 'title':
        patch.title = m.name;
        break;
      case 'description':
        patch.body = withDescription(doc, m.description ?? '', ctx);
        break;
      case 'targetDate':
        patch.dueDate = m.targetDate;
        break;
      case 'project':
        patch.parent =
          ctx.taskByRemote.get(m.projectId) ?? keepUnlinked(doc.meta, ctx);
        break;
      case 'archived':
        patch.archivedAt = m.archivedAt;
        break;
      case 'sortOrder':
        patch.sortOrder = m.sortOrder;
        break;
    }
  }
  return patch;
}

export function milestonePush(
  doc: TaskDoc,
  fields: Iterable<string>,
  ctx: LinearMapContext
): LinearMilestoneInput {
  const v = taskMilestoneValues(doc, ctx);
  const input: LinearMilestoneInput = {};
  for (const field of fields) {
    const value = v[field];
    if (value === UNMAPPED || PULL_ONLY_CONTAINER_FIELDS.has(field)) continue;
    switch (field) {
      case 'title':
        input.name = value as string;
        break;
      case 'description':
        input.description = value as string;
        break;
      case 'targetDate':
        input.targetDate = value as string | null;
        break;
      case 'project':
        if (value !== null) input.projectId = value as string;
        break;
      case 'sortOrder':
        input.sortOrder = value as number;
        break;
    }
  }
  return input;
}

// ---------------------------------------------------------------------------
// Initiatives

export function initiativeValues(
  i: LinearInitiative,
  ctx: LinearMapContext
): Values {
  return {
    title: i.name,
    description: longText(i.content, i.description, ctx),
    status: remoteStatusValue(i.status, initiativeCategory(i), ctx),
    owner: i.ownerId,
    targetDate: i.targetDate,
    color: i.color,
    icon: i.icon,
    archived: i.archivedAt !== null,
  };
}

export function taskInitiativeValues(
  doc: TaskDoc,
  ctx: LinearMapContext
): Values {
  const { meta } = doc;
  return {
    title: meta.title,
    description: description(doc, ctx),
    status: localStatusValue(meta.status, INITIATIVE_NAMES, ctx),
    owner: linearUserOf(meta.assignee, ctx),
    targetDate: meta.dueDate,
    color: meta.color,
    icon: meta.icon,
    archived: meta.archivedAt !== undefined,
  };
}

export function initiativePatch(
  i: LinearInitiative,
  fields: Iterable<string>,
  doc: TaskDoc,
  ctx: LinearMapContext
): UpdatePatch {
  const patch: UpdatePatch = {};
  const v = initiativeValues(i, ctx);
  for (const field of fields) {
    switch (field) {
      case 'title':
        patch.title = i.name;
        break;
      case 'description':
        patch.body = withDescription(doc, v.description as string, ctx);
        break;
      case 'status':
        patch.status = statusFromRemote(
          i.status,
          initiativeCategory(i),
          doc.meta.status,
          ctx
        );
        break;
      case 'owner':
        patch.assignee = refOf(i.ownerId, ctx);
        break;
      case 'targetDate':
        patch.dueDate = i.targetDate;
        break;
      case 'color':
        patch.color = i.color;
        break;
      case 'icon':
        patch.icon = i.icon;
        break;
      case 'archived':
        patch.archivedAt = i.archivedAt;
        break;
    }
  }
  return patch;
}

export function initiativePush(
  doc: TaskDoc,
  fields: Iterable<string>,
  ctx: LinearMapContext
): LinearInitiativeInput {
  const v = taskInitiativeValues(doc, ctx);
  const input: LinearInitiativeInput = {};
  for (const field of fields) {
    const value = v[field];
    if (value === UNMAPPED || PULL_ONLY_CONTAINER_FIELDS.has(field)) continue;
    switch (field) {
      case 'title':
        input.name = value as string;
        break;
      case 'description':
        input.content = value as string;
        break;
      case 'status':
        input.status =
          INITIATIVE_NAMES.find(([name]) => namedValue(name) === value)?.[0] ??
          CATEGORY_INITIATIVE[value as StatusType];
        break;
      case 'owner':
        input.ownerId = value as string | null;
        break;
      case 'targetDate':
        input.targetDate = value as string | null;
        break;
      case 'color':
        if (value !== null) input.color = value as string;
        break;
      case 'icon':
        input.icon = value as string | null;
        break;
    }
  }
  return input;
}

// ---------------------------------------------------------------------------
// Creation

/** A new container task for a Linear record; its fields arrive as a patch. */
export function containerCreate(
  entity: 'project' | 'milestone' | 'initiative',
  record: { id: string; name: string },
  status: string
): CreateInput {
  return {
    title: record.name,
    kind: entity,
    status,
    external: linearExternal({ entity, id: record.id }),
  };
}
