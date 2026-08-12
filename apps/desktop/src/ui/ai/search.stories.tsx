import { BotIcon, SquareCheckIcon, TerminalIcon } from 'lucide-react';
import { useState } from 'react';

import { type SearchGroup, SearchPanel } from './search';
import type { GalleryStory } from '@/views/galleryStories';

// Dispatch-flavored groups: open tasks, live agents, and quick commands — the three
// kinds of thing a person is most likely to jump to from a search overlay.
const SEARCH_GROUPS: SearchGroup[] = [
  {
    id: 'tasks',
    label: 'Tasks',
    items: [
      {
        id: 't-716d89',
        label: 'Rework the kanban columns',
        icon: <SquareCheckIcon aria-hidden className="size-3.5" />,
        hint: 'In progress',
      },
      {
        id: 't-cafe27',
        label: 'Boot force-fail must say why',
        icon: <SquareCheckIcon aria-hidden className="size-3.5" />,
        hint: 'Review',
      },
      {
        id: 't-2dfa1d',
        label: 'See all agents that are working',
        icon: <SquareCheckIcon aria-hidden className="size-3.5" />,
        hint: 'Todo',
      },
    ],
  },
  {
    id: 'agents',
    label: 'Agents',
    items: [
      {
        id: 'a-warden',
        label: 'Warden',
        icon: <BotIcon aria-hidden className="size-3.5" />,
        hint: 'Working',
      },
      {
        id: 'a-cartographer',
        label: 'Cartographer',
        icon: <BotIcon aria-hidden className="size-3.5" />,
        hint: 'Idle',
      },
    ],
  },
  {
    id: 'commands',
    label: 'Commands',
    items: [
      {
        id: 'c-new-run',
        label: 'Start a new run',
        icon: <TerminalIcon aria-hidden className="size-3.5" />,
        kbd: '⌘N',
      },
      {
        id: 'c-open-gallery',
        label: 'Open component gallery',
        icon: <TerminalIcon aria-hidden className="size-3.5" />,
        kbd: '⌘G',
      },
    ],
  },
];

// Fully controlled — same stateful-wrapper pattern the other primitive demos in
// galleryStories.tsx use — so typing actually filters and arrow keys actually move.
function SearchPanelDemo({
  groups,
  initialQuery = '',
  emptyHint,
}: {
  groups: SearchGroup[];
  initialQuery?: string;
  emptyHint: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  return (
    <div className="w-full max-w-72">
      <SearchPanel
        query={query}
        onQueryChange={setQuery}
        groups={groups}
        onSelect={() => {}}
        emptyHint={emptyHint}
      />
    </div>
  );
}

export const searchStories: GalleryStory[] = [
  {
    id: 'search-results',
    title: 'Search — results',
    note: 'Overlay panel, borderless input row with a hairline divider, grouped tasks/agents/commands with kbd hints. Arrow keys move the active row (bg-surface-hover); Enter selects it.',
    render: () => (
      <SearchPanelDemo
        groups={SEARCH_GROUPS}
        emptyHint="Try a different search term"
      />
    ),
  },
  {
    id: 'search-empty',
    title: 'Search — empty state',
    note: 'No group has a matching item: a centered muted icon plus the caller-supplied emptyHint.',
    render: () => (
      <SearchPanelDemo
        groups={SEARCH_GROUPS}
        initialQuery="zzz-no-match"
        emptyHint="Try a different search term"
      />
    ),
  },
];
