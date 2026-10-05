import type {
  ActorRef,
  Assignee,
  Priority,
  TaskKind,
} from '@dispatch-foo/core/browser';
import { parseActorRef } from '@dispatch-foo/core/browser';

// Mirrors the `tone` prop `Pill` accepts (see components/ui/Pill.tsx) —
// duplicated here rather than imported since Pill doesn't export its prop
// type.
type Tone = 'green' | 'blue' | 'red' | 'amber' | 'gray' | 'accent';

/** Renders a raw config status id as a human label — `in-progress` becomes `In Progress`.
 * The board's flat columns and its swim-lane columns previously formatted the same status two
 * different ways (one raw lowercase, one CSS-uppercased), so both now route through here. */
export function statusLabel(status: string): string {
  return status
    .split('-')
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
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

const PRIORITY_LABEL: Record<Priority, string> = {
  none: 'No priority',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

/** The menu/rail wording for a priority — `No priority` rather than `None`, so an unset
 * value still names what it is unset *of*. */
export function priorityLabel(priority: Priority): string {
  return PRIORITY_LABEL[priority];
}

/** Parses an assignee for display without throwing: a malformed ref reads as a person
 * with the raw value for a handle, and a missing one (older task files) as unassigned. */
export function assigneeRef(
  assignee: Assignee | null | undefined
): ActorRef | null {
  if (assignee === null || assignee === undefined || assignee === '') {
    return null;
  }
  try {
    return parseActorRef(assignee);
  } catch {
    return { kind: 'human', handle: assignee, operator: null };
  }
}

/** The menu/rail wording for an assignee wire value: `Unassigned` for `none`, the bare
 * kinds as `Agent`/`Human`, and a named ref by its handle (`human:wyat` → `wyat`,
 * `agent:wyat/claude` → `claude`). */
export function assigneeLabel(assignee: Assignee | null | undefined): string {
  const ref = assigneeRef(assignee);
  if (ref === null) return 'Unassigned';
  if (ref.handle !== null) return ref.handle;
  return ref.kind === 'agent' ? 'Agent' : 'Human';
}

const KIND_LABEL: Record<TaskKind, string> = {
  task: 'Task',
  milestone: 'Milestone',
  project: 'Project',
  initiative: 'Initiative',
};

export function kindLabel(kind: TaskKind): string {
  return KIND_LABEL[kind];
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
