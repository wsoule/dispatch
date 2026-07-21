import type { ProjectSummary } from './types';

/** Filters `projects` down to the ones flagged dispatch-enabled in `hasDispatchByPath` (keyed
 * by `project.path`) — the "Relay project list ∩ has-.dispatch" filter TasksView's nav list
 * needs. Pure and separate from the `has_dispatch` Tauri calls themselves so the combining
 * logic is unit-testable without mocking IPC. A path missing from the map (still loading, or
 * its `has_dispatch` call failed) is treated as not dispatch-enabled rather than shown
 * optimistically. */
export function filterDispatchEnabledProjects(
  projects: ProjectSummary[],
  hasDispatchByPath: Map<string, boolean>
): ProjectSummary[] {
  return projects.filter((p) => hasDispatchByPath.get(p.path) === true);
}

/** Collapses `projects` down to one row per distinct filesystem path, keeping whichever row
 * appeared first. Relay's own project list can contain more than one row for the same path
 * (one per originating agent-log source it was detected from — Claude Code, Codex, etc.), but
 * a dispatchd sidecar is 1:1 with a *path*, never with Relay's row id: `ensure_dispatchd` and
 * `has_dispatch` both take a path, not a project id. Every dispatch-facing consumer (the
 * sidebar's project switcher, the command palette's project-switch entries, the "All Agents"
 * cross-project fan-out) should see the deduped list — querying/spawning the same sidecar
 * once per *row* instead of once per *path* wastes a request at best, and at worst two rows
 * sharing an in-flight "port not resolved yet" placeholder collide on the same query key. */
export function dedupeProjectsByPath(
  projects: ProjectSummary[]
): ProjectSummary[] {
  const seenPaths = new Set<string>();
  const deduped: ProjectSummary[] = [];
  for (const project of projects) {
    if (seenPaths.has(project.path)) continue;
    seenPaths.add(project.path);
    deduped.push(project);
  }
  return deduped;
}
