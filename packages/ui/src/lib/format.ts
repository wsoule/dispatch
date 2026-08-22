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

/** Formats an ISO-8601 timestamp as the same short relative string `formatRelativeTime`
 * produces from unix seconds. Returns an em dash for a timestamp that fails to parse rather
 * than throwing or rendering "NaNm ago". */
export function formatRelativeTimeFromIso(iso: string): string {
  const unixSeconds = new Date(iso).getTime() / 1000;
  return Number.isNaN(unixSeconds) ? '—' : formatRelativeTime(unixSeconds);
}
