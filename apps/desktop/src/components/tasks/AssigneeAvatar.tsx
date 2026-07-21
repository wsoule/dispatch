import type { Assignee } from '@dispatch/core';
import { Bot, User } from 'lucide-react';

import { cn } from '@/lib/utils';

const ASSIGNEE_LABEL: Record<Assignee, string> = {
  agent: 'Assigned to an agent',
  human: 'Assigned to a person',
  none: 'Unassigned',
};

export interface AssigneeAvatarProps {
  assignee: Assignee;
  className?: string;
}

/**
 * Small avatar standing in for Linear's assignee circle: a bot glyph for an agent, a person
 * glyph for a human, and an empty dashed ring for unassigned — the redesign brief's exact
 * three-state treatment. Uses lucide (already a dependency) rather than a custom SVG, unlike
 * `StatusIcon`/`PriorityIcon`, since the brief calls out "agent = a small bot/cpu lucide
 * glyph in a circle, human = person" directly.
 */
export function AssigneeAvatar({ assignee, className }: AssigneeAvatarProps) {
  const label = ASSIGNEE_LABEL[assignee];

  if (assignee === 'none') {
    return (
      <span
        title={label}
        aria-label={label}
        role="img"
        className={cn(
          'inline-block size-4 shrink-0 rounded-full border border-dashed border-muted-foreground/40',
          className
        )}
      />
    );
  }

  const Icon = assignee === 'agent' ? Bot : User;
  return (
    <span
      title={label}
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground',
        className
      )}
    >
      <Icon className="size-2.5" strokeWidth={2} aria-label={label} />
    </span>
  );
}
