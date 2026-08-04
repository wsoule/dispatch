/** What saving the task body editor's draft should actually do. */
export type BodySaveDecision =
  | { kind: 'unchanged' }
  | { kind: 'stale' }
  | { kind: 'save'; body: string };

/**
 * Decides whether a whole-body edit is safe to write.
 *
 * The body editor replaces the task's entire markdown body in one PATCH, which
 * makes it the one editor in the app that can destroy writes it never saw.
 * Agents append to `## Activity` through a separate path (`appendActivity`)
 * while the dialog sits open, so a draft opened five minutes ago would quietly
 * erase every line appended since.
 *
 * `openedWith` is the body snapshotted when the editor opened and `current` is
 * the task's body now; a difference between them means someone else wrote in
 * the meantime and the draft can no longer be trusted as a full replacement.
 * A draft that already matches `current` is reported as unchanged first, so a
 * concurrent write that happens to agree with the draft closes the editor
 * cleanly instead of raising a conflict there's nothing to resolve.
 */
export function decideBodySave(
  openedWith: string,
  current: string,
  draft: string
): BodySaveDecision {
  if (draft === current) return { kind: 'unchanged' };
  if (current !== openedWith) return { kind: 'stale' };
  return { kind: 'save', body: draft };
}
