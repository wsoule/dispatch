import { useState } from 'react';

import type { RailGroup, ThreadSummary } from '../../lib/threads';
import type { ThreadLookups } from '../../lib/threadSources';
import { ThreadList } from './ThreadList';
import { GroupHeader } from '@/ui/ai/group-header';

const GROUPS: readonly { key: RailGroup; name: string }[] = [
  { key: 'needs-you', name: 'Needs you' },
  { key: 'channels', name: 'Channels' },
  { key: 'direct', name: 'Direct' },
];

export interface ThreadRailProps {
  groups: Record<RailGroup, ThreadSummary[]>;
  selected: string | null;
  onSelect: (thread: string) => void;
  lookups: ThreadLookups;
}

/** The Threads rail: Needs you, Channels and Direct, each collapsible, in one listbox. */
export function ThreadRail({
  groups,
  selected,
  onSelect,
  lookups,
}: ThreadRailProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<RailGroup>>(
    () => new Set()
  );
  const toggle = (key: RailGroup) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <ThreadList
      label="Threads"
      sections={GROUPS.map(({ key, name }) => ({
        key,
        name,
        header: (
          <GroupHeader
            name={name}
            count={groups[key].length}
            collapsed={collapsed.has(key)}
            onToggle={() => toggle(key)}
          />
        ),
        summaries: groups[key],
        collapsed: collapsed.has(key),
      }))}
      selected={selected}
      onSelect={onSelect}
      lookups={lookups}
    />
  );
}
