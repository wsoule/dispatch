import type { Assignee } from '@dispatch/core/browser';
import { Bot, User } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/ui/avatar';

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
      <Avatar
        title={label}
        aria-label={label}
        role="img"
        className={cn(
          'size-4 border border-dashed border-muted-foreground/40 bg-transparent',
          className
        )}
      />
    );
  }

  // An agent-owned card is the one Dispatch-specific thing about this app's assignees, so the
  // agent avatar carries the indigo working tint while a human stays neutral — at a glance the
  // board says which cards the fleet owns.
  const Icon = assignee === 'agent' ? Bot : User;
  return (
    <Avatar title={label} className={cn('size-4', className)}>
      <AvatarFallback
        aria-label={label}
        className={cn(
          'rounded-full',
          assignee === 'agent'
            ? 'bg-state-working-surface text-state-working'
            : 'bg-muted text-muted-foreground'
        )}
      >
        <Icon className="size-2.5" strokeWidth={2} aria-hidden="true" />
      </AvatarFallback>
    </Avatar>
  );
}
