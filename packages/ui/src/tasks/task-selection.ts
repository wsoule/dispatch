// Pure helpers for a list's selection: a set of row ids the host owns and
// the table (and the host's own commands) change. Every helper returns a
// new set and leaves its input alone, so a host can keep the selection in
// React state and compare by identity. Used by TaskGroupTable and by hosts
// (the planner's Issues page prunes its selection against the rows it
// shows on every render).

/** Adds `id` when it is missing, removes it when it is there. */
export function toggleId(
  selected: ReadonlySet<string>,
  id: string
): ReadonlySet<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * The ids from `anchor` to `target` inclusive, in `order` (the rows in the
 * order they are drawn), whichever of the two comes first. A missing anchor
 * starts the range at the target; a missing target gives [].
 */
export function rangeIds(
  order: readonly string[],
  anchor: string,
  target: string
): string[] {
  const to = order.indexOf(target);
  if (to < 0) return [];
  const found = order.indexOf(anchor);
  const from = found < 0 ? to : found;
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** Turns every id in `ids` on (or off). Returns `selected` itself when
    nothing changes, so a host's state update can bail out. */
export function setIds(
  selected: ReadonlySet<string>,
  ids: readonly string[],
  on: boolean
): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const id of ids) {
    if (selected.has(id) === on) continue;
    next ??= new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
  }
  return next ?? selected;
}

/** The selection limited to the rows still shown. Returns `selected`
    itself when every id is shown. */
export function pruneSelection(
  selected: ReadonlySet<string>,
  shown: ReadonlySet<string>
): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const id of selected) {
    if (shown.has(id)) continue;
    next ??= new Set(selected);
    next.delete(id);
  }
  return next ?? selected;
}
