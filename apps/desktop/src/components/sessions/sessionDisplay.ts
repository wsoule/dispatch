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

/** Fraction of a session's input tokens that were served from the prompt cache, as a 0–100
 * percentage string (e.g. `"87%"`), or `"—"` when the session has no input tokens at all yet
 * (division would be undefined). The denominator is every token that entered the model —
 * fresh prompt tokens + cache-creation (first-write) tokens + cache-read (reused) tokens — so
 * a high value means most context was reused from cache rather than re-sent, which is the main
 * driver of low per-session cost. Kept here (not inline) so it's unit-testable and shared if
 * another surface wants the same number. */
export function cacheHitRateDisplay(session: {
  prompt_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}): string {
  const totalInput =
    session.prompt_tokens +
    session.cache_read_tokens +
    session.cache_creation_tokens;
  if (totalInput <= 0) return '—';
  const pct = (session.cache_read_tokens / totalInput) * 100;
  return `${Math.round(pct)}%`;
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
