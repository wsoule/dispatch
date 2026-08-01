/** True when there's enough to group and the open-item id set (compared as a set, so a pure
 * reorder doesn't count) differs from what was last clustered. */
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
