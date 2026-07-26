import type { ProjectSummary, Session } from '../../lib/types';

/** Session status renders as a small colored dot rather than a filled pill — green while the
 * session is still active, a muted dot once it's ended. Shared by every session row/detail
 * surface in the Sessions hub (list, timeline, project detail, detail modal) so the
 * status → color mapping lives in exactly one place. */
export function statusDotClass(status: Session['status']): string {
  return status === 'active' ? 'bg-emerald-500' : 'bg-muted-foreground/50';
}

/** `tags` is stored as a JSON array string (e.g. `["bugfix","refactor"]`); falls back to
 * treating the raw string as a single tag if it doesn't parse, rather than hiding it. Shared
 * by `SessionDetailModal` and `TimelineView` so the two never diverge in how they interpret
 * the same stored value. */
export function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === 'string');
    }
    return [tags];
  } catch {
    return [tags];
  }
}

/** Resolves a session's project id to its display name, falling back to the raw id while the
 * project list hasn't loaded yet (or the project has since disappeared). Shared by
 * `SessionsView` and `TimelineView`, the two flat (non-project-scoped) session lists. */
export function projectNameFor(
  projects: ProjectSummary[] | undefined,
  projectId: string
): string {
  return projects?.find((p) => p.id === projectId)?.name ?? projectId;
}
