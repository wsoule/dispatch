import type { UiTone } from '@dispatch/ui';

import type { ProjectSummary, Session } from '../../lib/types';

/** The `UiTone` a session status renders in, for the `data-tone` dot beside its status word.
 * A live (active) session is blue, `info`, per the status hue table in AGENTS.md (blue means
 * in progress and live); an ended session is grey, `muted`. The word always sits beside the
 * dot, so the colour is never the only signal. Shared by `SessionRow` and
 * `SessionDetailModal` so the status → tone mapping lives in one place. */
export function sessionStatusTone(status: Session['status']): UiTone {
  switch (status) {
    case 'active':
      return 'info';
    case 'ended':
      return 'muted';
  }
}

/** The spend windows the Usage toolbar's segmented window control offers, in days. 30 is the
 * default — `ReportView`'s own former default, kept when the range picker was cut. */
export const SPEND_WINDOWS: readonly number[] = [7, 30, 90];

export const DEFAULT_SPEND_WINDOW = 30;

/** A window option's label: `7 days`, `30 days`, `90 days`. */
export function spendWindowLabel(days: number): string {
  return `${String(days)} days`;
}

/** `tags` is stored as a JSON array string (e.g. `["bugfix","refactor"]`); falls back to
 * treating the raw string as a single tag if it doesn't parse, rather than hiding it. Used by
 * `SessionDetailModal` to render a session's tag chips. */
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
 * project list hasn't loaded yet (or the project has since disappeared). Used by the Sessions
 * hub's flat session list (`SessionsHubView`) to label each row with its project name. */
export function projectNameFor(
  projects: ProjectSummary[] | undefined,
  projectId: string
): string {
  return projects?.find((p) => p.id === projectId)?.name ?? projectId;
}
