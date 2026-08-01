/** The archive toggle must stay visible whenever it is ON, otherwise turning it
 *  on can delete the only control that turns it off. */
export function showArchiveToggle(
  showArchived: boolean,
  archivedCount: number
): boolean {
  return showArchived || archivedCount > 0;
}
