// Resolving the legacy free-form `milestone` value to a real container. Tasks
// no longer carry that string (their container is `parent`), but old clients,
// scripts and `--milestone` flags still name a milestone by title. Browser-safe.
import { canonicalKind, isValidParentKind } from './kinds.js';

// The migration turned each old value into a project; Linear's own
// milestones are milestones. Either may be what a caller means.
const NAMEABLE_KINDS: ReadonlySet<string> = new Set(['milestone', 'project']);

export interface ContainerCandidate {
  meta: { id: string; title: string; kind: string; archivedAt?: string };
}

export type ContainerRefResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export interface MilestoneRefOptions {
  /** The kind of task being filed; defaults to an issue. */
  childKind?: string;
  /** A `parent` sent alongside, which must name the same container. */
  parent?: string | null;
}

/**
 * The project or milestone `ref` names, by id or by title (trimmed, then
 * case-insensitive), checked as a valid parent for a `childKind` task.
 * Archived containers match by id only. Several matches is an error, never
 * a guess: the caller should send `parent` instead.
 */
export function resolveMilestoneRef(
  tasks: Iterable<ContainerCandidate>,
  ref: string,
  { childKind = 'task', parent = null }: MilestoneRefOptions = {}
): ContainerRefResult {
  const wanted = ref.trim();
  if (wanted === '') {
    return {
      ok: false,
      error: 'invalid milestone: expected a project or milestone title',
    };
  }
  const lower = wanted.toLowerCase();
  let byId: ContainerCandidate | null = null;
  const exact: ContainerCandidate[] = [];
  const folded: ContainerCandidate[] = [];
  for (const task of tasks) {
    if (!NAMEABLE_KINDS.has(canonicalKind(task.meta.kind))) continue;
    if (task.meta.id === wanted) {
      byId = task;
      break;
    }
    if (task.meta.archivedAt !== undefined) continue;
    const title = task.meta.title.trim();
    if (title === wanted) exact.push(task);
    else if (title.toLowerCase() === lower) folded.push(task);
  }
  const matches = byId !== null ? [byId] : exact.length > 0 ? exact : folded;
  if (matches.length === 0) {
    return {
      ok: false,
      error: `invalid milestone: no project or milestone is titled "${wanted}" — create it first, or send parent`,
    };
  }
  if (matches.length > 1) {
    const names = matches
      .map((m) => `${m.meta.id} (${canonicalKind(m.meta.kind)})`)
      .join(', ');
    return {
      ok: false,
      error: `invalid milestone: "${wanted}" matches ${names} — send parent instead`,
    };
  }
  const container = matches[0];
  const kind = canonicalKind(container.meta.kind);
  if (!isValidParentKind(childKind, kind)) {
    return {
      ok: false,
      error: `invalid milestone: a ${canonicalKind(childKind)} cannot sit under ${kind} ${container.meta.id}`,
    };
  }
  if (parent !== null && parent !== container.meta.id) {
    return {
      ok: false,
      error: `invalid milestone: "${wanted}" is ${container.meta.id}, but parent is ${parent} — send parent only`,
    };
  }
  return { ok: true, id: container.meta.id };
}
