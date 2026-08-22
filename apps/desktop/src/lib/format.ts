// The relative-time formatters moved to @dispatch/ui (packages/ui), whose components render
// them; re-exported so app callers keep their `@/lib/format` import path.
export { formatRelativeTime, formatRelativeTimeFromIso } from '@/ui/lib/format';

/** A session's best available display name: Claude Code's own auto-generated title first
 * (matches "Session name" in `claude`'s `/status` and `--resume` picker), falling back to
 * the app's own AI-generated one-line summary, then a fixed placeholder if neither exists yet. */
export function sessionDisplayName(
  title: string | null,
  summary: string | null
): string {
  return title ?? summary ?? 'Untitled session';
}

/** Compact token count for dense rows: 950 → "950 tok", 12_345 → "12.3k tok". Keeps a
 * session's prompt+completion volume scannable in a slot too narrow for "12,345 tokens". */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k tok`;
  return `${String(tokens)} tok`;
}
