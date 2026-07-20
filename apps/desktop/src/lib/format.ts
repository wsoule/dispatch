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
