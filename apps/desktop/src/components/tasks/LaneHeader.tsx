import type { Priority } from '@dispatch-foo/core/browser';

import type { BoardLane } from '../../lib/boardGrouping';
import { AssigneeAvatar } from './AssigneeAvatar';
import { PriorityIcon } from './PriorityIcon';
import { GroupHeader } from '@/ui/ai/group-header';

interface LaneHeaderProps {
  /** An assignee or priority lane — `lane.value` is the raw assignee string or the priority. */
  lane: BoardLane;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * The board's lane header for an assignee or priority swim lane (Display › Sub-grouping): a
 * 36px `GroupHeader` with no tint, the assignee's avatar or the priority glyph, the lane
 * title as the collapse target and the card count. No `+`: a new task can be preset to an
 * epic or a status, not to an assignee or a priority.
 */
export function LaneHeader({ lane, expanded, onToggle }: LaneHeaderProps) {
  const value = lane.value ?? '';
  return (
    <GroupHeader
      icon={
        lane.kind === 'assignee' ? (
          <AssigneeAvatar assignee={value} size={16} />
        ) : (
          <PriorityIcon priority={value as Priority} />
        )
      }
      name={
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="focus-visible:ring-ring inline-flex max-w-full cursor-pointer items-center rounded-[4px] text-left outline-none focus-visible:ring-2"
        >
          <span className="truncate">{lane.title}</span>
        </button>
      }
      count={lane.total}
      collapsed={!expanded}
      onToggle={onToggle}
      className="mb-2"
    />
  );
}
