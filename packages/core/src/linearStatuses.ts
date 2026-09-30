// A linked team's workflow states as the project's statuses: one status per
// state, same name, type, color and order, so a custom state round-trips
// exactly. Pure: no node:* imports.
import type { LinearWorkflowState } from './linearMap.js';
import { resolveWorkflowState } from './linearMap.js';
import type {
  StatusDefinition,
  StatusModel,
  StatusRoles,
  StatusType,
} from './status.js';
import {
  canonicalStatus,
  STATUS_ROLE_KEYS,
  STATUS_TYPES,
  statusesOfType,
  statusType,
} from './status.js';

/** The statuses a team's states generate, and which state each one is. */
export interface GeneratedStatuses {
  definitions: StatusDefinition[];
  /** Workflow state id -> status name. */
  names: Record<string, string>;
}

/** A Linear state type as a status type; `duplicate` is a kind of canceled. */
export function statusTypeOfState(type: string): StatusType {
  if (type === 'duplicate') return 'canceled';
  return (STATUS_TYPES as readonly string[]).includes(type)
    ? (type as StatusType)
    : 'backlog';
}

// A state named like a legacy alias (`done`, `todo`) would be rewritten to a
// built-in on every read, so it keeps Linear's name with a capital instead.
function safeName(raw: string): string {
  const name = raw.trim() === '' ? 'Untitled' : raw.trim();
  if (canonicalStatus(name) === name) return name;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

// A team's states in Linear's board order: by type, then position, then name.
function boardOrder(
  states: readonly LinearWorkflowState[]
): LinearWorkflowState[] {
  const order = (s: LinearWorkflowState) =>
    STATUS_TYPES.indexOf(statusTypeOfState(s.type));
  return [...states].sort((a, b) => {
    const byType = order(a) - order(b);
    if (byType !== 0) return byType;
    const byPosition = (a.position ?? 0) - (b.position ?? 0);
    return byPosition !== 0 ? byPosition : a.name.localeCompare(b.name);
  });
}

/** Statuses in Linear's board order: by type, then position within the type. */
export function statusesFromWorkflowStates(
  states: readonly LinearWorkflowState[]
): GeneratedStatuses {
  return statusesFromTeams([states]);
}

/**
 * The statuses several linked teams' workflows generate together, primary
 * team first. A state merges into a status another team already generated
 * when both its name (case-insensitively) and its type match, so teams on the
 * stock workflow share one Todo, one In Progress and so on; any other state
 * is a status of its own, suffixed ` (2)` on a name clash. Names are settled
 * team by team, so linking another team never renames the primary's statuses.
 * Within a type, the primary's order holds and another team's extra states
 * slot in after the state they follow on that team's board.
 */
export function statusesFromTeams(
  teams: readonly (readonly LinearWorkflowState[])[]
): GeneratedStatuses {
  interface Merged {
    definition: StatusDefinition;
    teams: Set<number>;
  }
  const byKey = new Map<string, Merged>();
  const used = new Set<string>();
  const names: Record<string, string> = {};
  const ordered = teams.map(boardOrder);
  // Pass 1: which status each state is, naming new ones team by team.
  const statusOf: Merged[][] = ordered.map((states, t) =>
    states.map((state) => {
      const type = statusTypeOfState(state.type);
      const key = `${state.name.trim().toLowerCase()}\u0000${type}`;
      const shared = byKey.get(key);
      if (shared !== undefined && !shared.teams.has(t)) {
        shared.teams.add(t);
        names[state.id] = shared.definition.name;
        return shared;
      }
      const base = safeName(state.name);
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base} (${n})`;
      used.add(name);
      names[state.id] = name;
      const merged: Merged = {
        definition: { name, type, color: state.color ?? null },
        teams: new Set([t]),
      };
      if (shared === undefined) byKey.set(key, merged);
      return merged;
    })
  );
  // Pass 2: board order within each type, each team's new statuses placed
  // after the status its previous state of that type became.
  const definitions: StatusDefinition[] = [];
  for (const type of STATUS_TYPES) {
    const block: Merged[] = [];
    ordered.forEach((states, t) => {
      let after = -1;
      states.forEach((state, i) => {
        if (statusTypeOfState(state.type) !== type) return;
        const merged = statusOf[t][i];
        const at = block.indexOf(merged);
        if (at >= 0) {
          after = Math.max(after, at);
          return;
        }
        block.splice(after + 1, 0, merged);
        after += 1;
      });
    });
    for (const merged of block) definitions.push(merged.definition);
  }
  return { definitions, names };
}

/**
 * The lifecycle roles a generated status list implies: runs start in the first
 * started state, review lands in the first started state named like "review"
 * (else the first started one), work merges into the first completed state and
 * is dropped into the first canceled one. Landing is a run fact, not a status.
 */
export function defaultStatusRoles(
  definitions: readonly StatusDefinition[]
): StatusRoles {
  const ofType = (type: StatusType) =>
    definitions.filter((d) => d.type === type).map((d) => d.name);
  const first = (...types: StatusType[]) => {
    for (const type of types) {
      const hit = ofType(type)[0];
      if (hit !== undefined) return hit;
    }
    return definitions[0]?.name ?? '';
  };
  const dispatched = first('started', 'unstarted');
  return {
    ready: first('unstarted', 'backlog', 'triage'),
    dispatched,
    review:
      ofType('started').find((name) => /review/i.test(name)) ?? dispatched,
    landing: null,
    landed: first('completed'),
    dropped: first('canceled', 'completed'),
  };
}

/**
 * The default roles for several linked teams: the primary team's statuses
 * alone decide them, so linking another team never moves a lifecycle role
 * onto a status only that team has (its states can sort first in a type).
 */
export function primaryStatusRoles(
  generated: GeneratedStatuses,
  primary: readonly LinearWorkflowState[]
): StatusRoles {
  const own = new Set(primary.map((s) => generated.names[s.id]));
  const definitions = generated.definitions.filter((d) => own.has(d.name));
  return defaultStatusRoles(
    definitions.length > 0 ? definitions : generated.definitions
  );
}

/**
 * The roles to write after regenerating statuses. A role the user changed away
 * from what the last generation wrote is an override and survives, following a
 * rename, as long as it still names a status; everything else takes the fresh
 * default. With no previous generation (the first link) there are no overrides.
 */
export function reconcileStatusRoles(
  current: StatusRoles | undefined,
  lastGenerated: StatusRoles | null,
  fresh: StatusRoles,
  names: readonly string[],
  renames: ReadonlyMap<string, string>
): StatusRoles {
  if (current === undefined || lastGenerated === null) return { ...fresh };
  const valid = new Set(names);
  const out: StatusRoles = { ...fresh };
  for (const key of STATUS_ROLE_KEYS) {
    const mine = current[key];
    if (mine === lastGenerated[key]) continue;
    if (mine === null) {
      if (key === 'landing') out.landing = null;
      continue;
    }
    const renamed = renames.get(mine) ?? mine;
    if (!valid.has(renamed)) continue;
    if (key === 'landing') out.landing = renamed;
    else out[key] = renamed;
  }
  return out;
}

/**
 * How generated status names moved between two generations. Teams merged
 * onto one status can rename it apart, so a name moves for everyone only when
 * every state that carried it agrees; each team's own renames are kept too.
 */
export interface StatusRenames {
  /** Old name -> new, where every state that carried the old name agrees. */
  shared: Map<string, string>;
  /** Team id -> old name -> new, for that team's renamed states. */
  byTeam: Map<string, Map<string, string>>;
}

/** The renames between two generations; `teamOf` maps state id -> team id. */
export function statusRenames(
  previous: Readonly<Record<string, string>>,
  next: Readonly<Record<string, string>>,
  teamOf: ReadonlyMap<string, string> = new Map()
): StatusRenames {
  const votes = new Map<string, Set<string>>();
  const byTeam = new Map<string, Map<string, string>>();
  for (const [stateId, before] of Object.entries(previous)) {
    const after = next[stateId];
    if (after === undefined) continue;
    const vote = votes.get(before) ?? new Set<string>();
    vote.add(after);
    votes.set(before, vote);
    const team = teamOf.get(stateId);
    if (after === before || team === undefined) continue;
    const own = byTeam.get(team) ?? new Map<string, string>();
    own.set(before, after);
    byTeam.set(team, own);
  }
  const shared = new Map<string, string>();
  for (const [before, afters] of votes) {
    const [after] = afters;
    if (afters.size === 1 && after !== before) shared.set(before, after);
  }
  return { shared, byTeam };
}

/**
 * The renames a task follows: its issue's team's own over the shared ones.
 * A task with no known team (unlinked, or never seen) follows only the shared.
 */
export function renamesForTeam(
  renames: StatusRenames,
  teamId: string | null
): ReadonlyMap<string, string> {
  const own = teamId === null ? undefined : renames.byTeam.get(teamId);
  if (own === undefined) return renames.shared;
  return new Map([...renames.shared, ...own]);
}

/** Everything `migrateStatus` needs about the old and new vocabularies. */
export interface StatusMigration {
  renames: ReadonlyMap<string, string>;
  /** The model statuses were read under before this generation. */
  before: StatusModel;
  /** The model being written. */
  after: StatusModel;
  /** The pre-generation `linear.statusMap` (status -> state name or type). */
  legacyMap: Readonly<Record<string, string>>;
  states: readonly LinearWorkflowState[];
  names: Readonly<Record<string, string>>;
}

/**
 * The status a task should hold under the new vocabulary: its renamed state,
 * then itself if still defined, then where the old status map pointed, then
 * the status holding the same lifecycle role, then the first of the same type,
 * then the ready role.
 */
export function migrateStatus(status: string, m: StatusMigration): string {
  const valid = new Set(m.after.definitions.map((d) => d.name));
  const renamed = m.renames.get(status);
  if (renamed !== undefined) return renamed;
  if (valid.has(status)) return status;
  const mapped = resolveWorkflowState(status, { ...m.legacyMap }, [
    ...m.states,
  ]);
  const mappedName = mapped === null ? undefined : m.names[mapped.id];
  if (mappedName !== undefined && valid.has(mappedName)) return mappedName;
  for (const key of STATUS_ROLE_KEYS) {
    if (m.before.roles[key] !== status) continue;
    const target = m.after.roles[key];
    if (target !== null && valid.has(target)) return target;
  }
  const sameType = statusesOfType(statusType(status, m.before), m.after)[0];
  return sameType ?? m.after.roles.ready;
}
