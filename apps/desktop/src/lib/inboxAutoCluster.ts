/**
 * Decides whether the background clustering pass should re-run. This is a pure decision so the
 * `useEffect` driving it in BrainDumpView has exactly one thing to get right: it fires only when
 * there is enough to group AND the open-item id set genuinely differs from what was last
 * clustered. Comparing as sets (not arrays) means a pure reorder — same items, new order — never
 * re-triggers a call, and a `null` baseline (nothing clustered yet) always does once the minimum
 * is met.
 */
export function shouldRecluster(
  openItemIds: string[],
  lastClusteredIds: string[] | null,
  minItems: number
): boolean {
  if (openItemIds.length < minItems) return false;
  if (lastClusteredIds === null) return true;
  if (openItemIds.length !== lastClusteredIds.length) return true;
  const last = new Set(lastClusteredIds);
  return openItemIds.some((id) => !last.has(id));
}
