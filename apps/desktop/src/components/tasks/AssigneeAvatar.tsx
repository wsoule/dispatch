import type { Assignee } from '@dispatch-foo/core/browser';
import { cx, InitialsAvatar } from '@dispatch/ui';
import { useState } from 'react';

import { assigneeLabel, assigneeRef } from '../../lib/taskDisplay';
import { usePeople } from '../people/PeopleContext';
import styles from './AssigneeAvatar.module.css';

export interface AssigneeAvatarProps {
  assignee: Assignee;
  /** The person's display name, for initials (`Wyat Soule` → `WS`). Falls back to the
   * people registry's name for the ref, then the ref's handle, then the assignee kind. */
  name?: string;
  /** 18px on rows and cards (default); 16px on activity timeline lines and picker faces. */
  size?: 16 | 18;
  className?: string;
}

/**
 * The 18px assignee circle. An agent is `AG` on the in-progress blue (`data-tone="info"`:
 * at a glance the board says which cards the fleet owns); a person is their photo when the
 * registry has one, else the library's InitialsAvatar on the decorative hue it hashes from
 * the name; unassigned is an empty dashed ring. The outer element carries the accessible
 * name (`role="img"`), so the library avatar inside stays hidden from assistive tech.
 */
export function AssigneeAvatar({
  assignee,
  name,
  size = 18,
  className,
}: AssigneeAvatarProps) {
  const kind = assigneeRef(assignee)?.kind ?? 'none';
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
        data-kind="none"
        data-size={size}
        className={cx(styles.avatar, styles.empty, className)}
      />
    );
  }

  if (kind === 'agent') {
    return (
      <span
        role="img"
        aria-label="Agent"
        title={name ?? assigneeLabel(assignee)}
        data-slot="assignee-avatar"
        data-kind="agent"
        data-size={size}
        data-tone="info"
        className={cx(styles.avatar, styles.agent, className)}
      >
        AG
      </span>
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
        data-size={size}
        className={cx(styles.avatar, styles.photo, className)}
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={displayName}
      title={displayName}
      data-slot="assignee-avatar"
      data-kind="human"
      data-size={size}
      className={cx(styles.avatar, className)}
    >
      <InitialsAvatar name={displayName} />
    </span>
  );
}
