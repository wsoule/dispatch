import type { Priority } from '@dispatch-foo/core/browser';
import { PriorityGlyph, SectionHeader } from '@dispatch/ui';

import { toTaskPriority } from '../../adapters/rows';
import type { BoardLane } from '../../lib/boardGrouping';
import { AssigneeAvatar } from './AssigneeAvatar';
import styles from './LaneHeader.module.css';

interface LaneHeaderProps {
  /** An assignee or priority lane — `lane.value` is the raw assignee string or the priority. */
  lane: BoardLane;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * A lane header's title as its collapse target: a plain text button that keeps the
 * heading's look, with `aria-expanded` and the focus ring. Shared by `LaneHeader` and
 * `MilestoneLaneHeader`; the legacy `group-header-name` hook wraps it so the board's tests
 * and e2e find the title the same way on every lane kind.
 */
export function LaneTitleButton({
  title,
  expanded,
  onToggle,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <span data-slot="group-header-name" className={styles.name}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={styles.titleButton}
      >
        <span className={styles.titleText}>{title}</span>
      </button>
    </span>
  );
}

/**
 * The board's lane header for an assignee or priority swim lane (Display › Sub-grouping): a
 * `SectionHeader` with no tone, the assignee's 16px avatar or the priority glyph, the lane
 * title as the collapse target and the card count. No `+`: a new task can be preset to a
 * milestone or a status, not to an assignee or a priority.
 */
export function LaneHeader({ lane, expanded, onToggle }: LaneHeaderProps) {
  const value = lane.value ?? '';
  return (
    <SectionHeader
      data-slot="group-header"
      className={styles.header}
      icon={
        <span data-slot="group-header-icon" className={styles.icon}>
          {lane.kind === 'assignee' ? (
            <AssigneeAvatar assignee={value} size={16} />
          ) : (
            // Decorative: the lane title beside it names the priority.
            <PriorityGlyph priority={toTaskPriority(value as Priority)} />
          )}
        </span>
      }
      name={
        <LaneTitleButton
          title={lane.title}
          expanded={expanded}
          onToggle={onToggle}
        />
      }
      count={lane.total}
      collapsed={!expanded}
      onToggle={onToggle}
    />
  );
}
