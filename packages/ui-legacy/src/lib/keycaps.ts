/** Splits a shortcut string into its keycaps on whitespace: `G S` → two caps, `⌘1` → one.
 * Shared by the command menu and the search panel so both print chords the same way. */
export function splitKeycaps(kbd: string): string[] {
  return kbd.split(/\s+/).filter(Boolean);
}
