/** The task page's line for a run live on a teammate's machine: where it
 *  runs and whom it waits on; null when there is neither. */
export function presenceLine(
  presence: { replica: string; handle: string; device: string } | null,
  waitingOn: string | null
): string | null {
  const where =
    presence === null
      ? null
      : `Running on ${presence.handle}'s ${presence.device}`;
  const waiting = waitingOn === null ? null : `waiting on ${waitingOn}`;
  if (where === null) return waiting;
  return waiting === null ? where : `${where}, ${waiting}`;
}
