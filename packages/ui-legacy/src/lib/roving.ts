/** Where a roving-tabindex widget (tab list, radio group) moves on a key press: arrows
 * step and wrap, Home/End jump to the edges, anything else returns `null` so the caller
 * leaves the event alone. */
export function nextRovingIndex(
  key: string,
  current: number,
  count: number
): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** Moves DOM focus to the `index`-th element matching `selector` inside `root` — the
 * second half of a roving tabindex, after the caller has picked the new index. */
export function focusRovingItem(
  root: HTMLElement,
  selector: string,
  index: number
) {
  const items = root.querySelectorAll<HTMLElement>(selector);
  items[index]?.focus();
}
