// Pure timestamp comparison, no node:* imports, so this is safe for the
// desktop webview via the '@dispatch/core/browser' entry point.

/**
 * Whether a task's content has moved past the version a consumer last
 * accounted for. False when it moved backwards — a branch checkout holding an
 * older revision must never be pushed as if it were new work (see 53190d6).
 * Unparseable timestamps are treated as not-outstanding: when in doubt, hold.
 */
export function isOutstanding(
  updated: string,
  lastAccounted: string | undefined
): boolean {
  if (lastAccounted === undefined) return true;
  const now = Date.parse(updated);
  const then = Date.parse(lastAccounted);
  if (Number.isNaN(now) || Number.isNaN(then)) return false;
  return now > then;
}
