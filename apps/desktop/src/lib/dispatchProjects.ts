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
