import type { TaskListItem } from '@dispatch-foo/core/browser';
import { canonicalKind, isContainerKind } from '@dispatch-foo/core/browser';

// Which tasks a container's Flight Plan draws, and in which bands. A milestone or parent
// issue plans its direct children — the ones its fan-out session dispatches. A project or
// initiative is too broad to fan out itself, so its plan is the work under its container
// children, one band per child container (a project's milestones, an initiative's
// projects), with its own direct tasks in a trailing band.

/** A band's key for the scope container's own direct tasks. */
export const DIRECT_BAND = '__direct';

interface FlightBandDef {
  key: string;
  /** The band's container; null for the scope's own direct tasks. */
  container: TaskListItem | null;
}

export interface FlightScope {
  /** The work to plan, in a stable order (created, then id). */
  nodes: TaskListItem[];
  /** Bands in display order; null when the plan is one set without bands. */
  bands: FlightBandDef[] | null;
  /** Each node's band key; empty when `bands` is null. */
  bandOf: ReadonlyMap<string, string>;
}

/** Children by parent id — built once per task list and shared by every scope read. */
export function childrenByParent(
  tasks: readonly TaskListItem[]
): Map<string, TaskListItem[]> {
  const out = new Map<string, TaskListItem[]>();
  for (const task of tasks) {
    const parent = task.meta.parent;
    if (parent === null) continue;
    const bucket = out.get(parent);
    if (bucket === undefined) out.set(parent, [task]);
    else bucket.push(task);
  }
  return out;
}

function byCreatedThenId(a: TaskListItem, b: TaskListItem): number {
  const byCreated = a.meta.created.localeCompare(b.meta.created);
  return byCreated !== 0 ? byCreated : a.meta.id.localeCompare(b.meta.id);
}

// Bands read in the container's own order (Linear's milestone sortOrder, unordered
// last), then by when the work is due (undated last), then by age.
function bandOrder(a: TaskListItem, b: TaskListItem): number {
  const ao = a.meta.sortOrder ?? null;
  const bo = b.meta.sortOrder ?? null;
  if (ao !== bo) {
    if (ao === null) return 1;
    if (bo === null) return -1;
    return ao - bo;
  }
  const ad = a.meta.dueDate ?? null;
  const bd = b.meta.dueDate ?? null;
  if (ad !== bd) {
    if (ad === null) return 1;
    if (bd === null) return -1;
    return ad.localeCompare(bd);
  }
  return byCreatedThenId(a, b);
}

// Every non-container-kind task under `rootId`, descending only through container kinds
// (a parent issue is one node; its sub-issues belong to its own plan). Cycle-safe.
function workUnder(
  rootId: string,
  children: ReadonlyMap<string, readonly TaskListItem[]>,
  seen: Set<string>
): TaskListItem[] {
  const out: TaskListItem[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    for (const child of children.get(id) ?? []) {
      if (isContainerKind(child.meta.kind)) stack.push(child.meta.id);
      else if (!seen.has(child.meta.id)) {
        seen.add(child.meta.id);
        out.push(child);
      }
    }
  }
  return out;
}

/** The tasks and bands `container`'s Flight Plan draws. */
export function flightScope(
  container: TaskListItem,
  children: ReadonlyMap<string, readonly TaskListItem[]>
): FlightScope {
  const id = container.meta.id;
  const direct = children.get(id) ?? [];
  const kind = canonicalKind(container.meta.kind);
  const broad = kind === 'project' || kind === 'initiative';
  const bandContainers = broad
    ? direct.filter((c) => isContainerKind(c.meta.kind))
    : [];

  if (bandContainers.length === 0) {
    return {
      nodes: direct
        .filter((c) => !isContainerKind(c.meta.kind))
        .sort(byCreatedThenId),
      bands: null,
      bandOf: new Map(),
    };
  }

  const seen = new Set<string>([id]);
  const nodes: TaskListItem[] = [];
  const bandOf = new Map<string, string>();
  const bands: FlightBandDef[] = [];
  for (const band of [...bandContainers].sort(bandOrder)) {
    const work = workUnder(band.meta.id, children, seen).sort(byCreatedThenId);
    bands.push({ key: band.meta.id, container: band });
    for (const task of work) {
      nodes.push(task);
      bandOf.set(task.meta.id, band.meta.id);
    }
  }
  const own = direct
    .filter((c) => !isContainerKind(c.meta.kind) && !seen.has(c.meta.id))
    .sort(byCreatedThenId);
  if (own.length > 0) {
    bands.push({ key: DIRECT_BAND, container: null });
    for (const task of own) {
      nodes.push(task);
      bandOf.set(task.meta.id, DIRECT_BAND);
    }
  }
  return { nodes, bands, bandOf };
}

/**
 * Whether two scopes hold the very same task objects in the same bands. The cached task
 * list keeps an untouched task's object across a patch, so a change elsewhere in the
 * project yields an equal scope, and the caller keeps the old one — nothing downstream
 * recomputes.
 */
export function sameScope(a: FlightScope, b: FlightScope): boolean {
  if (a.nodes.length !== b.nodes.length) return false;
  for (let i = 0; i < a.nodes.length; i++) {
    if (a.nodes[i] !== b.nodes[i]) return false;
  }
  if (a.bands === null || b.bands === null) return a.bands === b.bands;
  if (a.bands.length !== b.bands.length) return false;
  for (let i = 0; i < a.bands.length; i++) {
    const x = a.bands[i];
    const y = b.bands[i];
    if (x?.key !== y?.key || x?.container !== y?.container) return false;
  }
  for (const [id, band] of a.bandOf) {
    if (b.bandOf.get(id) !== band) return false;
  }
  return true;
}
