import type { Assignee } from '@dispatch-foo/core/browser';
import { useState } from 'react';

import { colorForProject } from '../../lib/projectColor';
import { assigneeLabel, assigneeRef } from '../../lib/taskDisplay';
import { usePeople } from '../people/PeopleContext';
import { cn } from '@/lib/utils';
import { InitialsAvatar } from '@/ui/ai/initials-avatar';

export interface AssigneeAvatarProps {
  assignee: Assignee;
  /** The person's display name, for initials (`Wyat Soule` → `WS`). Falls back to the
   * people registry's name for the ref, then the ref's handle, then the assignee kind. */
  name?: string;
  /** 18px on rows and cards (default); 16px on activity timeline lines. */
  size?: 16 | 18;
  className?: string;
}

// 18px is `InitialsAvatar`'s own size, so only the 16px variant overrides — restating
// `leading-none` because tailwind-merge drops the primitive's when a `text-[…]` size lands.
const SIZE_CLASS: Record<16 | 18, string> = {
  16: 'size-4 text-[8px] leading-none',
  18: '',
};

/**
 * Linear's 18px assignee circle: an agent is `AG` on the in-progress yellow (the one
 * Dispatch-specific thing about assignees — at a glance the board says which cards the
 * fleet owns), a person is their photo when the registry has one or else their initials on
 * a colour hashed from their name, and unassigned is an empty dashed ring.
 */
export function AssigneeAvatar({
  assignee,
  name,
  size = 18,
  className,
}: AssigneeAvatarProps) {
  const kind = assigneeRef(assignee)?.kind ?? 'none';
  const sizeClass = SIZE_CLASS[size];
  const person = usePeople().personFor(assignee);
  // The photo that failed to load (a host the CSP refuses, a dead link).
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);

  if (kind === 'none') {
    const label = assigneeLabel(assignee);
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        data-slot="assignee-avatar"
        className={cn(
          'inline-block shrink-0 rounded-pill border-[0.5px] border-dashed border-muted-foreground/50',
          sizeClass,
          className
        )}
      />
    );
  }

  if (kind === 'agent') {
    return (
      <InitialsAvatar
        name="Agent"
        title={name ?? assigneeLabel(assignee)}
        color="var(--status-progress)"
        data-kind="agent"
        className={cn(sizeClass, className)}
      />
    );
  }

  const displayName = name ?? person?.name ?? assigneeLabel(assignee);
  const avatarUrl = person?.avatarUrl ?? null;
  if (avatarUrl !== null && avatarUrl !== '' && avatarUrl !== brokenUrl) {
    return (
      <img
        src={avatarUrl}
        onError={() => setBrokenUrl(avatarUrl)}
        alt={displayName}
        title={displayName}
        data-slot="assignee-avatar"
        data-kind="human"
        className={cn(
          'inline-block size-[18px] shrink-0 rounded-pill object-cover',
          sizeClass,
          className
        )}
      />
    );
  }
  return (
    <InitialsAvatar
      name={displayName}
      title={displayName}
      color={colorForProject(displayName)}
      data-kind="human"
      className={cn(sizeClass, className)}
    />
  );
}
