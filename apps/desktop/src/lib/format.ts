/** A session's best available display name: Claude Code's own auto-generated title first
 * (matches "Session name" in `claude`'s `/status` and `--resume` picker), falling back to
 * Relay's own AI-generated one-line summary, then a fixed placeholder if neither exists yet. */
export function sessionDisplayName(
  title: string | null,
  summary: string | null
): string {
  return title ?? summary ?? 'Untitled session';
}

/** Formats a unix-seconds timestamp as a short relative time string, e.g. "5m ago". */
export function formatRelativeTime(unixSeconds: number): string {
  const diffMs = Date.now() - unixSeconds * 1000;
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

/** Formats a task's ISO-8601 `updated`/`created` frontmatter timestamp as the same short
 * relative string `formatRelativeTime` produces from unix seconds — the board/list card
 * footer's "Updated 2d ago", the closest analog to Linear's "Created May 1" line. Returns an
 * em dash for a timestamp that fails to parse rather than throwing or rendering "NaNm ago". */
export function formatRelativeTimeFromIso(iso: string): string {
  const unixSeconds = new Date(iso).getTime() / 1000;
  return Number.isNaN(unixSeconds) ? '—' : formatRelativeTime(unixSeconds);
}
