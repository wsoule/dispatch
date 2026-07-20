import type { Priority } from '@dispatch/core';

// Mirrors the `tone` prop `Pill` accepts (see components/ui/Pill.tsx) —
// duplicated here rather than imported since Pill doesn't export its prop
// type.
type Tone = 'green' | 'blue' | 'red' | 'amber' | 'gray' | 'accent';

/** Maps a task status to a Pill tone. The six built-in statuses
 * (backlog/todo/in-progress/in-review/done/cancelled) get a deliberate
 * color; anything else — a custom status from a project's
 * `.dispatch/config.yml` — falls back to neutral gray so a board column
 * header never renders unstyled. */
export function statusTone(status: string): Tone {
  switch (status) {
    case 'in-progress':
      return 'blue';
    case 'in-review':
      return 'amber';
    case 'done':
      return 'green';
    case 'cancelled':
      return 'red';
    default:
      return 'gray';
  }
}

/** Only urgent/high get a color treatment; medium/low/none stay silent so the one accent
 * color and the two priority colors don't compete for attention on a dense board. Returns
 * `null` for anything that shouldn't render a pill at all (the 'none' priority — the common
 * case for most tasks shouldn't cost a chip). */
export function priorityTone(priority: Priority): Tone | null {
  switch (priority) {
    case 'urgent':
      return 'red';
    case 'high':
      return 'amber';
    default:
      return null;
  }
}

// A task body is `## Description\n\n...\n\n## Acceptance Criteria\n\n## Activity\n` (see
// core/store.ts's create template). Splits it into a heading -> content map so each section
// renders as its own plain block — no markdown parser, just `white-space: pre-wrap` per the
// design direction. Mirrors packages/web/src/components/TaskDetail.tsx's own copy of this —
// display-only body parsing, out of @dispatch/client's extraction scope the same way
// taskGraph.ts's blocked-badge logic is.
export function parseTaskSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = body.split(/^## /m).slice(1);
  for (const part of parts) {
    const newlineIndex = part.indexOf('\n');
    const heading = (
      newlineIndex === -1 ? part : part.slice(0, newlineIndex)
    ).trim();
    const content =
      newlineIndex === -1 ? '' : part.slice(newlineIndex + 1).trim();
    sections.set(heading, content);
  }
  return sections;
}

/** Empty sections (e.g. an unfilled Acceptance Criteria) should read the same as a missing
 * one — both just mean "nothing here yet." */
export function sectionOrDash(
  sections: Map<string, string>,
  heading: string
): string {
  const content = sections.get(heading);
  return content !== undefined && content !== '' ? content : '—';
}
