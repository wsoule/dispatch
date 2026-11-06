// Maps Linear GraphQL nodes (as selected by queries.ts) into the core domain
// types. Every input is `unknown` and narrowed field by field; required
// fields that are missing raise LinearApiError('graphql') naming the field.
// Linear-specific quirks are normalised here, once:
// - Issue.priority is a Float → rounded and clamped to 0..4.
// - WorkflowState.type "duplicate" → canceled; unknown types → backlog.
// - Timestamps are normalised to `toISOString()` so string order is time
//   order; TimelessDate values are kept as `YYYY-MM-DD`.

import {
  type BlockingRelation,
  type EstimateScale,
  type Initiative,
  isEstimateScaleType,
  type IsoDate,
  type IsoDateTime,
  type Issue,
  type IssueComment,
  type IssueLabel,
  type Milestone,
  type Priority,
  type Project,
  type ProjectStatusType,
  type Team,
  type TeamVisibility,
  type User,
  type WorkflowState,
  type WorkflowStateType,
} from '@dispatch/planning';

import type { LinearLogger } from './client.js';
import { LinearApiError } from './gateway.js';
import {
  isRecord,
  type JsonObject,
  optionalBoolean,
  optionalNumber,
  optionalObject,
  optionalRefId,
  optionalString,
  readConnection,
  requireBoolean,
  requireRefId,
  requireString,
} from './json.js';

function asNode(value: unknown, entity: string): JsonObject {
  if (!isRecord(value)) {
    throw new LinearApiError(
      'graphql',
      `Malformed Linear response: ${entity} is not an object`
    );
  }
  return value;
}

/** Linear priority (Float on issues, Int elsewhere) → 0..4. */
export function mapPriority(value: unknown): Priority {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  if (rounded <= 0) return 0;
  if (rounded >= 4) return 4;
  return rounded as Priority;
}

const WORKFLOW_STATE_TYPES: ReadonlySet<string> = new Set<WorkflowStateType>([
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
]);

/**
 * WorkflowState.type is a free String in Linear's schema. "duplicate" is a
 * closed state (→ canceled); anything unknown becomes backlog (open, never
 * auto-started) and is logged so a schema change is noticed.
 */
export function mapWorkflowStateType(
  type: string,
  logger?: LinearLogger,
  stateId?: string
): WorkflowStateType {
  if (type === 'duplicate') return 'canceled';
  if (WORKFLOW_STATE_TYPES.has(type)) return type as WorkflowStateType;
  logger?.warn('unknown Linear workflow state type; treating as backlog', {
    type,
    stateId: stateId ?? null,
  });
  return 'backlog';
}

const PROJECT_STATUS_TYPES: ReadonlySet<string> = new Set<ProjectStatusType>([
  'backlog',
  'planned',
  'started',
  'paused',
  'completed',
  'canceled',
]);

/**
 * ProjectStatus.type (an enum in the SDL). An unknown future value maps to
 * backlog, which is not an active status, so the tool never writes to a
 * project it does not understand.
 */
export function mapProjectStatusType(
  type: string,
  logger?: LinearLogger,
  projectId?: string
): ProjectStatusType {
  if (PROJECT_STATUS_TYPES.has(type)) return type as ProjectStatusType;
  logger?.warn('unknown Linear project status type; treating as backlog', {
    type,
    projectId: projectId ?? null,
  });
  return 'backlog';
}

// Parses a DateTime string and re-serialises it so every timestamp in the
// mirror has the same format; null when absent or unparseable.
function optionalDateTime(obj: JsonObject, key: string): IsoDateTime | null {
  const raw = optionalString(obj, key);
  if (raw === null) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function requireDateTime(
  obj: JsonObject,
  key: string,
  entity: string
): IsoDateTime {
  const value = optionalDateTime(obj, key);
  if (value === null) {
    throw new LinearApiError(
      'graphql',
      `Malformed Linear response: ${entity}.${key} is not a timestamp`
    );
  }
  return value;
}

const TIMELESS_DATE = /^(\d{4}-\d{2}-\d{2})/;

/** A TimelessDate (`YYYY-MM-DD`), or null when absent or malformed. */
function optionalTimelessDate(obj: JsonObject, key: string): IsoDate | null {
  const raw = optionalString(obj, key);
  if (raw === null) return null;
  return TIMELESS_DATE.exec(raw)?.[1] ?? null;
}

// Ids of a nested `{ nodes { id } pageInfo { hasNextPage } }` connection.
// These lists are fetched with a small `first` (complexity budget), so a
// longer list is logged instead of being cut off silently.
function connectionIds(
  obj: JsonObject,
  key: string,
  entity: string,
  logger: LinearLogger | undefined,
  entityId: string
): string[] {
  const value = obj[key];
  if (value === undefined || value === null) return [];
  const page = readConnection(value, `${entity}.${key}`);
  const ids: string[] = [];
  for (const node of page.nodes) {
    const id = optionalString(node, 'id');
    if (id !== null) ids.push(id);
  }
  if (page.hasNextPage) {
    logger?.warn('linear id list truncated; only the first page is kept', {
      entity,
      field: key,
      id: entityId,
      kept: ids.length,
    });
  }
  return ids;
}

/**
 * The sync's fallback for Issue.lastStateChangeAt: the latest of the
 * lifecycle timestamps Linear always returns. It underestimates moves
 * between open states (e.g. Todo → In Review), which is why the engine
 * refines it with fetchLastStateChanges for milestones that matter.
 */
export function approximateLastStateChangeAt(issue: {
  createdAt: IsoDateTime;
  startedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  canceledAt: IsoDateTime | null;
}): IsoDateTime {
  let latest = issue.createdAt;
  let latestMs = Date.parse(latest);
  for (const candidate of [
    issue.startedAt,
    issue.completedAt,
    issue.canceledAt,
  ]) {
    if (candidate === null) continue;
    const ms = Date.parse(candidate);
    if (ms > latestMs) {
      latest = candidate;
      latestMs = ms;
    }
  }
  return latest;
}

export function mapUser(value: unknown): User {
  const node = asNode(value, 'User');
  const email = optionalString(node, 'email');
  return {
    id: requireString(node, 'id', 'User'),
    name: requireString(node, 'name', 'User'),
    displayName:
      optionalString(node, 'displayName') ??
      requireString(node, 'name', 'User'),
    email: email === null || email.trim() === '' ? null : email,
    avatarUrl: optionalString(node, 'avatarUrl'),
    active: requireBoolean(node, 'active', 'User'),
    app: requireBoolean(node, 'app', 'User'),
    guest: optionalBoolean(node, 'guest') === true,
  };
}

/**
 * Linear's Team.visibility. An unknown value reads as `private` (visible to
 * the team's members only) and is logged: when unsure, show less.
 */
export function mapTeamVisibility(
  value: unknown,
  logger?: LinearLogger
): TeamVisibility {
  if (value === 'public' || value === 'private' || value === 'restricted') {
    return value;
  }
  logger?.warn('unknown Linear team visibility; treating it as private', {
    visibility: value,
  });
  return 'private';
}

/**
 * A Team node (TeamFields). `memberIds` are the team's members from the
 * memberships read beside the teams (empty when none are known).
 */
export function mapTeam(
  value: unknown,
  memberIds: readonly string[] = [],
  logger?: LinearLogger
): Team {
  const node = asNode(value, 'Team');
  const parent = optionalObject(node, 'parent');
  return {
    id: requireString(node, 'id', 'Team'),
    key: requireString(node, 'key', 'Team'),
    name: requireString(node, 'name', 'Team'),
    visibility: mapTeamVisibility(node['visibility'], logger),
    parentId: parent === null ? null : optionalString(parent, 'id'),
    memberIds: [...memberIds],
  };
}

/**
 * A TeamMembership node ({ team { id } user { id } }) as a pair, or null
 * when either end is missing.
 */
export function mapTeamMembership(
  value: unknown
): { teamId: string; userId: string } | null {
  const node = asNode(value, 'TeamMembership');
  const team = optionalObject(node, 'team');
  const user = optionalObject(node, 'user');
  const teamId = team === null ? null : optionalString(team, 'id');
  const userId = user === null ? null : optionalString(user, 'id');
  return teamId === null || userId === null ? null : { teamId, userId };
}

export function mapWorkflowState(
  value: unknown,
  logger?: LinearLogger
): WorkflowState {
  const node = asNode(value, 'WorkflowState');
  const id = requireString(node, 'id', 'WorkflowState');
  return {
    id,
    teamId: requireRefId(node, 'team', 'WorkflowState'),
    name: requireString(node, 'name', 'WorkflowState'),
    type: mapWorkflowStateType(
      requireString(node, 'type', 'WorkflowState'),
      logger,
      id
    ),
    position: optionalNumber(node, 'position') ?? 0,
  };
}

export function mapInitiative(value: unknown): Initiative {
  const node = asNode(value, 'Initiative');
  return {
    id: requireString(node, 'id', 'Initiative'),
    name: requireString(node, 'name', 'Initiative'),
    sortOrder: optionalNumber(node, 'sortOrder') ?? 0,
    priority: mapPriority(node['priority']),
    targetDate: optionalTimelessDate(node, 'targetDate'),
  };
}

export function mapProject(value: unknown, logger?: LinearLogger): Project {
  const node = asNode(value, 'Project');
  const id = requireString(node, 'id', 'Project');
  const status = optionalObject(node, 'status');
  const statusType = status === null ? null : optionalString(status, 'type');
  if (status === null || statusType === null) {
    throw new LinearApiError(
      'graphql',
      'Malformed Linear response: Project.status.type is missing'
    );
  }
  return {
    id,
    name: requireString(node, 'name', 'Project'),
    url: requireString(node, 'url', 'Project'),
    leadId: optionalRefId(node, 'lead'),
    priority: mapPriority(node['priority']),
    sortOrder: optionalNumber(node, 'sortOrder') ?? 0,
    statusType: mapProjectStatusType(statusType, logger, id),
    statusName: optionalString(status, 'name') ?? statusType,
    initiativeIds: connectionIds(node, 'initiatives', 'Project', logger, id),
    teamIds: connectionIds(node, 'teams', 'Project', logger, id),
    startDate: optionalTimelessDate(node, 'startDate'),
    targetDate: optionalTimelessDate(node, 'targetDate'),
  };
}

export function mapMilestone(value: unknown): Milestone {
  const node = asNode(value, 'ProjectMilestone');
  return {
    id: requireString(node, 'id', 'ProjectMilestone'),
    projectId: requireRefId(node, 'project', 'ProjectMilestone'),
    name: requireString(node, 'name', 'ProjectMilestone'),
    description: optionalString(node, 'description'),
    targetDate: optionalTimelessDate(node, 'targetDate'),
    sortOrder: optionalNumber(node, 'sortOrder') ?? 0,
  };
}

export function mapIssue(value: unknown): Issue {
  const node = asNode(value, 'Issue');
  const createdAt = requireDateTime(node, 'createdAt', 'Issue');
  const startedAt = optionalDateTime(node, 'startedAt');
  const completedAt = optionalDateTime(node, 'completedAt');
  const canceledAt = optionalDateTime(node, 'canceledAt');
  return {
    id: requireString(node, 'id', 'Issue'),
    identifier: requireString(node, 'identifier', 'Issue'),
    title: requireString(node, 'title', 'Issue'),
    url: requireString(node, 'url', 'Issue'),
    teamId: requireRefId(node, 'team', 'Issue'),
    projectId: optionalRefId(node, 'project'),
    milestoneId: optionalRefId(node, 'projectMilestone'),
    assigneeId: optionalRefId(node, 'assignee'),
    stateId: requireRefId(node, 'state', 'Issue'),
    priority: mapPriority(node['priority']),
    createdAt,
    updatedAt: optionalDateTime(node, 'updatedAt') ?? createdAt,
    startedAt,
    completedAt,
    canceledAt,
    lastStateChangeAt: approximateLastStateChangeAt({
      createdAt,
      startedAt,
      completedAt,
      canceledAt,
    }),
    dueDate: optionalTimelessDate(node, 'dueDate'),
  };
}

/**
 * A Linear IssueRelation as a BlockingRelation, or null for every type
 * other than "blocks" (related, duplicate, similar…). For "blocks", `issue`
 * is the blocker and `relatedIssue` the blocked one.
 */
export function mapBlockingRelation(value: unknown): BlockingRelation | null {
  const node = asNode(value, 'IssueRelation');
  if (optionalString(node, 'type') !== 'blocks') return null;
  return {
    id: requireString(node, 'id', 'IssueRelation'),
    blockerId: requireRefId(node, 'issue', 'IssueRelation'),
    blockedId: requireRefId(node, 'relatedIssue', 'IssueRelation'),
  };
}

/** True when a single-entity node is archived (or trashed, for issues). */
export function isArchivedNode(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    optionalString(value, 'archivedAt') !== null || value['trashed'] === true
  );
}

// ---------------------------------------------------------------------------
// Issue page (owner decision 2026-10-21)
// ---------------------------------------------------------------------------

/**
 * An IssueLabel node (IssueLabelFields) as a core IssueLabel. Its parent is
 * the label group; a group without a groupType is single-select (Linear's
 * documented default).
 */
export function mapIssueLabel(value: unknown): IssueLabel {
  const node = asNode(value, 'IssueLabel');
  const parent = optionalObject(node, 'parent');
  const parentId = parent === null ? null : optionalString(parent, 'id');
  return {
    id: requireString(node, 'id', 'IssueLabel'),
    name: requireString(node, 'name', 'IssueLabel'),
    color: optionalString(node, 'color') ?? '',
    teamId: optionalRefId(node, 'team'),
    group:
      parent === null || parentId === null
        ? null
        : {
            id: parentId,
            name: optionalString(parent, 'name') ?? '',
            singleSelect: optionalString(parent, 'groupType') !== 'multiSelect',
          },
  };
}

/** True for a label group node (it cannot be applied to an issue). */
export function isLabelGroupNode(value: unknown): boolean {
  return isRecord(value) && value['isGroup'] === true;
}

/** A Comment node (CommentFields) as a core IssueComment. */
export function mapComment(value: unknown): IssueComment {
  const node = asNode(value, 'Comment');
  const user = optionalObject(node, 'user');
  const userId = user === null ? null : optionalString(user, 'id');
  const bot = optionalObject(node, 'botActor');
  const external = optionalObject(node, 'externalUser');
  return {
    id: requireString(node, 'id', 'Comment'),
    body: optionalString(node, 'body') ?? '',
    createdAt: requireDateTime(node, 'createdAt', 'Comment'),
    url: optionalString(node, 'url'),
    parentId: optionalRefId(node, 'parent'),
    author:
      user === null || userId === null
        ? null
        : { id: userId, name: optionalString(user, 'name') ?? '' },
    externalAuthor:
      user !== null && userId !== null
        ? null
        : ((bot === null ? null : optionalString(bot, 'name')) ??
          (external === null ? null : optionalString(external, 'name'))),
  };
}

/** A team that does not use estimates (also the fallback for unknowns). */
export const NO_ESTIMATES: EstimateScale = {
  type: 'notUsed',
  allowZero: false,
  extended: false,
};

/**
 * A Team node (EstimateScaleFields, with its `parent` chain) as the
 * estimate scale its issues use. A sub-team with inheritIssueEstimation
 * takes its parent's settings, following parents while they inherit too
 * (every level may inherit). A chain that still inherits where the query
 * stopped (deeper than TEAM_ANCESTOR_LEVELS) uses the last team read, and
 * is logged.
 * An unknown issueEstimationType (Linear sends a free string) reads as
 * `notUsed` and is logged, so the planner never offers values Linear would
 * reject.
 */
export function mapEstimateScale(
  value: unknown,
  logger?: LinearLogger
): EstimateScale {
  let node = asNode(value, 'Team');
  while (optionalBoolean(node, 'inheritIssueEstimation') === true) {
    const parent = optionalObject(node, 'parent');
    if (parent === null) {
      if (node['parent'] === undefined) {
        logger?.warn(
          'Linear team inherits estimates from beyond the levels read',
          { teamId: optionalString(node, 'id') }
        );
      }
      break;
    }
    node = parent;
  }
  const type = optionalString(node, 'issueEstimationType') ?? 'notUsed';
  if (!isEstimateScaleType(type)) {
    logger?.warn('unknown Linear estimate scale; treating as not used', {
      type,
      teamId: optionalString(node, 'id'),
    });
    return { ...NO_ESTIMATES };
  }
  return {
    type,
    allowZero: optionalBoolean(node, 'issueEstimationAllowZero') === true,
    extended: optionalBoolean(node, 'issueEstimationExtended') === true,
  };
}
