/**
 * The full prompt "Plan as milestone" hands the planner — a structured brief,
 * not a comma-splice of raw captures. Pure so the wording is pinned by tests.
 *
 * Vocabulary note: the UI says "milestone" (the planning-hierarchy direction,
 * e-be4827 — milestone IS today's epic, renamed), but the prompt speaks the
 * current planner's language. When t-4545da lands the epic→milestone rename
 * server-side, swap the word here too.
 */
export function buildMilestonePrompt(input: {
  /** The model-suggested title, when planning a suggested group. */
  title?: string | null;
  /** The model's one-line reason the items belong together, when it gave one. */
  reason?: string | null;
  /** The captured lines, verbatim. */
  items: string[];
}): string {
  const title = input.title?.trim() ?? '';
  const reason = input.reason?.trim() ?? '';
  return [
    title === ''
      ? 'Plan the following captured items as one epic.'
      : `Plan the following captured items as one epic: "${title}".`,
    reason === '' ? null : `Why they belong together: ${reason}`,
    'Captured items, verbatim:',
    // Multiline items indent their continuations so each bullet stays one item.
    input.items.map((text) => `- ${text.split('\n').join('\n  ')}`).join('\n'),
    'Create the epic with tasks that together cover every item above. Keep each task tightly scoped.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n\n');
}
