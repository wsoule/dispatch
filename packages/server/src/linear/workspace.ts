// The per-pass picture of the linked teams: their workflow states mirrored into
// the project's statuses, their users folded into the people registry, and the
// mapping context every field projection reads.
import {
  labelColorIndex,
  labelKey,
  loadConfig,
  migrateStatus,
  parseLinearExternal,
  peopleIndex,
  primaryStatusRoles,
  reconcileStatusRoles,
  renamesForTeam,
  resolvePeople,
  statusesFromTeams,
  statusModelOf,
  statusRenames,
  syncLinearLabels,
  syncLinearPeople,
  updateConfig,
} from '@dispatch/core';
import type {
  DispatchConfig,
  LabelColorPush,
  LinearLabel,
  LinearMapContext,
  LinearProjectStatus,
  LinearUser,
  LinearWorkflowState,
  StatusDefinition,
  StatusRoles,
  TaskDoc,
  TaskMeta,
  TaskStorePort,
} from '@dispatch/core';

import { rosterMembers } from '../api/people.js';
import type { LinearSyncState } from './state.js';

/** A mapping context whose indexes the pass keeps current as it writes. */
export interface PassContext extends LinearMapContext {
  tasks: Map<string, TaskMeta>;
  taskByRemote: Map<string, string>;
  labels: Map<string, LinearLabel[]>;
  labelsById: Map<string, LinearLabel>;
  /** The label registry's colors by lowercased ref, for labels a push creates. */
  labelColors: ReadonlyMap<string, string>;
}

function sameDefinitions(
  a: readonly StatusDefinition[] | undefined,
  b: readonly StatusDefinition[]
): boolean {
  return (
    a !== undefined &&
    a.length === b.length &&
    a.every(
      (d, i) =>
        d.name === b[i].name &&
        d.type === b[i].type &&
        (d.color ?? null) === (b[i].color ?? null)
    )
  );
}

function sameRoles(a: StatusRoles | undefined, b: StatusRoles): boolean {
  return (
    a !== undefined &&
    a.ready === b.ready &&
    a.dispatched === b.dispatched &&
    a.review === b.review &&
    a.landing === b.landing &&
    a.landed === b.landed &&
    a.dropped === b.dropped
  );
}

export interface StatusRegeneration {
  config: DispatchConfig;
  /** Whether config.yml was rewritten. */
  configChanged: boolean;
  /** Tasks whose status moved to the new vocabulary. */
  migrated: string[];
}

/** A linked team as status generation sees it, primary first. */
export interface WorkflowTeam {
  id: string;
  key: string;
  states: readonly LinearWorkflowState[];
}

/** The linked team a linked issue was last seen in, by its identifier's key. */
export function linkedIssueTeam(
  state: LinearSyncState,
  teamByKey: ReadonlyMap<string, string>,
  issueId: string
): string | null {
  const identifier = state.links[issueId]?.identifier ?? '';
  const key = identifier.slice(0, identifier.lastIndexOf('-'));
  return teamByKey.get(key) ?? null;
}

/**
 * Makes the project's statuses the linked teams' workflow states (names,
 * types, colors, order; merged across teams by name and type, see
 * statusesFromTeams) and its roles the generated defaults plus any user
 * override, then moves every task whose status left the vocabulary onto its
 * successor, following its own issue's team's renames. A migration is
 * bookkeeping, so it keeps each task's `updated`.
 */
export function regenerateStatuses(
  rootDir: string,
  store: TaskStorePort,
  docs: Map<string, TaskDoc>,
  state: LinearSyncState,
  teams: readonly WorkflowTeam[]
): StatusRegeneration {
  const config = loadConfig(rootDir);
  const states = teams.flatMap((t) => t.states);
  const generated = statusesFromTeams(teams.map((t) => t.states));
  if (generated.definitions.length === 0) {
    return { config, configChanged: false, migrated: [] };
  }
  const names = generated.definitions.map((d) => d.name);
  const teamOf = new Map(
    teams.flatMap((t) => t.states.map((s) => [s.id, t.id] as const))
  );
  const renames = statusRenames(state.stateNames, generated.names, teamOf);
  const fresh = primaryStatusRoles(generated, teams[0]?.states ?? []);
  const roles = reconcileStatusRoles(
    config.statusRoles,
    state.generatedRoles,
    fresh,
    names,
    renames.shared
  );
  state.stateNames = generated.names;
  state.generatedRoles = fresh;
  if (
    sameDefinitions(config.statusDefinitions, generated.definitions) &&
    sameRoles(config.statusRoles, roles)
  ) {
    return { config, configChanged: false, migrated: [] };
  }
  const before = statusModelOf(config);
  const after = { definitions: generated.definitions, roles };
  const next = updateConfig(rootDir, {
    statuses: generated.definitions.map((d) => ({
      name: d.name,
      type: d.type,
      color: d.color,
    })),
    statusRoles: roles,
  });
  const teamByKey = new Map(teams.map((t) => [t.key, t.id]));
  const perTeam = new Map<string | null, ReadonlyMap<string, string>>();
  const renamesOf = (doc: TaskDoc) => {
    const ref = parseLinearExternal(doc.meta.external);
    const team =
      ref?.entity === 'issue'
        ? linkedIssueTeam(state, teamByKey, ref.id)
        : null;
    let own = perTeam.get(team);
    if (own === undefined) {
      own = renamesForTeam(renames, team);
      perTeam.set(team, own);
    }
    return own;
  };
  const migrated: string[] = [];
  for (const doc of docs.values()) {
    const status = migrateStatus(doc.meta.status, {
      renames: renamesOf(doc),
      before,
      after,
      legacyMap: config.linear.statusMap,
      states,
      names: generated.names,
    });
    if (status === doc.meta.status) continue;
    const moved = store.update(doc.meta.id, { status }, doc.meta.updated);
    docs.set(moved.meta.id, moved);
    migrated.push(moved.meta.id);
  }
  return { config: next, configChanged: true, migrated };
}

/**
 * Folds the team's users into `people:`, the API key's own user as the local
 * human. Returns the config as it stands afterwards and whether it changed.
 */
export function syncPeople(
  rootDir: string,
  config: DispatchConfig,
  users: readonly LinearUser[],
  viewerId: string,
  localRef: string
): { config: DispatchConfig; changed: boolean } {
  const configured = config.people ?? [];
  const result = syncLinearPeople({
    configured,
    known: resolvePeople(configured, rosterMembers(rootDir)),
    users,
    viewerId,
    localRef,
  });
  if (!result.changed) return { config, changed: false };
  return {
    config: updateConfig(rootDir, { people: result.configured }),
    changed: true,
  };
}

/** What folding Linear's labels into the registry left behind. */
export interface LabelRegistrySync {
  config: DispatchConfig;
  changed: boolean;
  /** Local color edits to write to Linear. */
  push: LabelColorPush[];
  /** Why the registry could not be written, or null. */
  error: string | null;
}

/**
 * Folds the linked teams' labels into `labels:` and settles colors against
 * the stored base. `state.labelColors` takes the next base, which assumes the
 * color writes land. A registry that cannot be written is reported and left
 * as it was, base and all, so the rest of the pass still runs.
 */
export function syncLabels(
  rootDir: string,
  config: DispatchConfig,
  labels: readonly LinearLabel[],
  state: LinearSyncState,
  direction: { mayPull: boolean; mayPush: boolean }
): LabelRegistrySync {
  const result = syncLinearLabels({
    configured: config.labels ?? [],
    linear: labels,
    base: state.labelColors,
    ...direction,
  });
  let next = config;
  if (result.changed) {
    try {
      next = updateConfig(rootDir, { labels: result.configured });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return {
        config,
        changed: false,
        push: [],
        error: `label registry not updated: ${why}`,
      };
    }
  }
  state.labelColors = result.base;
  return {
    config: next,
    changed: result.changed,
    push: result.push,
    error: null,
  };
}

/** The linked teams as a mapping context sees them, primary first. */
export interface LinkedTeam {
  id: string;
  states: readonly LinearWorkflowState[];
}

/** The mapping context over the pass's task snapshot. */
export function buildContext(
  rootDir: string,
  config: DispatchConfig,
  state: LinearSyncState,
  docs: Map<string, TaskDoc>,
  labels: readonly LinearLabel[],
  projectStatuses: readonly LinearProjectStatus[],
  localRef: string,
  teams: readonly LinkedTeam[]
): PassContext {
  const tasks = new Map<string, TaskMeta>();
  const taskByRemote = new Map<string, string>();
  for (const doc of docs.values()) {
    tasks.set(doc.meta.id, doc.meta);
    const ref = parseLinearExternal(doc.meta.external);
    if (ref !== null) taskByRemote.set(ref.id, doc.meta.id);
  }
  const people = resolvePeople(config.people ?? [], rosterMembers(rootDir));
  const labelIndex = new Map<string, LinearLabel[]>();
  const labelsById = new Map<string, LinearLabel>();
  const ctx = { labels: labelIndex, labelsById };
  for (const label of labels) trackLabel(ctx, label);
  return {
    tasks,
    taskByRemote,
    statusByState: new Map(Object.entries(state.stateNames)),
    teamStates: new Map(teams.map((t) => [t.id, t.states])),
    defaultTeamId: teams[0]?.id ?? '',
    model: statusModelOf(config),
    people: peopleIndex(people, localRef),
    labels: labelIndex,
    labelsById,
    includeAcceptanceCriteria: config.linear.includeAcceptanceCriteria,
    projectStatuses,
    labelColors: labelColorIndex(config.labels ?? []),
  };
}

/** Keeps the context's indexes in step with a task the pass just wrote. */
export function track(ctx: PassContext, doc: TaskDoc): void {
  ctx.tasks.set(doc.meta.id, doc.meta);
  const ref = parseLinearExternal(doc.meta.external);
  if (ref !== null) ctx.taskByRemote.set(ref.id, doc.meta.id);
}

/** Refreshes the people index after `people:` changed mid-pass. */
export function refreshPeople(
  rootDir: string,
  ctx: PassContext,
  config: DispatchConfig
): void {
  ctx.people = peopleIndex(
    resolvePeople(config.people ?? [], rosterMembers(rootDir)),
    ctx.people.localRef
  );
}

/** Adds (or refreshes) a label in the context's indexes. */
export function trackLabel(
  ctx: Pick<PassContext, 'labels' | 'labelsById'>,
  label: LinearLabel
): void {
  const prior = ctx.labelsById.get(label.id);
  if (prior !== undefined) {
    const was = labelKey(prior).toLowerCase();
    const rest = (ctx.labels.get(was) ?? []).filter((l) => l.id !== label.id);
    if (rest.length === 0) ctx.labels.delete(was);
    else ctx.labels.set(was, rest);
  }
  const key = labelKey(label).toLowerCase();
  ctx.labels.set(key, [...(ctx.labels.get(key) ?? []), label]);
  ctx.labelsById.set(label.id, label);
}
