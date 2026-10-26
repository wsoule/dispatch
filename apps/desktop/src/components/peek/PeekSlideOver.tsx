import { Button, InitialsAvatar, SlideOver, type UiTone } from '@dispatch/ui';
import type { ReactNode } from 'react';

import styles from './PeekSlideOver.module.css';

// The peeks that are not a task (a person, a thread, an outside agent) in @dispatch/ui's
// SlideOver, the same panel the task's quick look uses: one peek at a time in App's peek
// slot, over whichever main view is showing, Esc and focus return the SlideOver's. The
// peek's own markup is @dispatch/ui and this sheet; the timelines and the thread pane
// inside are legacy content until Phase 7 restyles them.

/** One presence line: a dot (in its tone while they are here) and what they are doing. */
export function PresenceLine({
  live,
  tone = 'accent',
  children,
}: {
  live: boolean;
  /** The dot's hue while live: the accent for a teammate, success for a peer up. */
  tone?: UiTone;
  children: ReactNode;
}) {
  return (
    <span className={styles.presence} data-tone={live ? tone : 'muted'}>
      <i aria-hidden className={styles.dot} />
      <span className={styles.presenceText}>{children}</span>
    </span>
  );
}

/** A chip that opens something from a peek: a task, a settings page. */
export function PeekChip({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button size="sm" onClick={onClick}>
      {children}
    </Button>
  );
}

/** The panel's title with an avatar before it, and a note after it. */
export function PeekTitle({
  name,
  avatar = true,
  note,
}: {
  name: string;
  avatar?: boolean;
  /** A chip or a word after the name ("Outside"). */
  note?: ReactNode;
}) {
  return (
    <span className={styles.title}>
      {avatar && <InitialsAvatar name={name} size="md" />}
      <span className={styles.name}>{name}</span>
      {note}
    </span>
  );
}

export interface PeekSlideOverProps {
  /** Names the panel for tests (`person-peek`, `thread-peek`, `outside-peek`). */
  testId: string;
  /** Names what the panel shows (an address, a message id): a new one while open scrolls
   * the body back to the top. */
  contentKey: string;
  title: ReactNode;
  /** One line in the header bar: the address and what it is. */
  subtitle?: ReactNode;
  /** Header actions before the close button. */
  actions?: ReactNode;
  /** Presence, warnings and chips between the title and the timeline. */
  summary?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

/**
 * A peek in the shell's slide-over: the header bar carries the subtitle and the actions,
 * the heading the title, a summary block the facts, and the body (a timeline with its
 * composer, a thread) fills the rest of the panel and scrolls inside itself.
 */
export function PeekSlideOver({
  testId,
  contentKey,
  title,
  subtitle,
  actions,
  summary,
  onClose,
  children,
}: PeekSlideOverProps) {
  return (
    <SlideOver
      open
      onClose={onClose}
      title={title}
      breadcrumb={
        subtitle === undefined ? undefined : (
          <span className={`mono ${styles.subtitle}`}>{subtitle}</span>
        )
      }
      actions={actions}
      contentKey={contentKey}
    >
      <div data-testid={testId} data-slot="peek" className={styles.fill}>
        {summary !== undefined && (
          <div data-slot="peek-summary" className={styles.summary}>
            {summary}
          </div>
        )}
        <div className={styles.body}>{children}</div>
      </div>
    </SlideOver>
  );
}
