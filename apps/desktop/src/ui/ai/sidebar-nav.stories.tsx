import {
  ChevronsUpDownIcon,
  FolderGitIcon,
  InboxIcon,
  KanbanIcon,
  ListChecksIcon,
  UsersIcon,
} from 'lucide-react';
import { useState } from 'react';

import { SidebarNav, type SidebarNavSection } from './sidebar-nav';
import type { GalleryStory } from '@/views/galleryStories';

// Dispatch-shaped nav: a workspace section (Board, Inbox with an attention count) and
// an objects section (Plans, All agents, Repos) — covers icons, counts, the attention
// dot, and a section with no items styled differently from one with several.
const SIDEBAR_SECTIONS: SidebarNavSection[] = [
  {
    id: 'workspace',
    label: 'Workspace',
    items: [
      {
        id: 'board',
        label: 'Board',
        icon: <KanbanIcon />,
      },
      {
        id: 'inbox',
        label: 'Inbox',
        icon: <InboxIcon />,
        count: 3,
        state: 'attention',
      },
    ],
  },
  {
    id: 'objects',
    label: 'Objects',
    items: [
      {
        id: 'plans',
        label: 'Plans',
        icon: <ListChecksIcon />,
        count: 6,
      },
      {
        id: 'all-agents',
        label: 'All agents',
        icon: <UsersIcon />,
        count: 4,
      },
      {
        id: 'repos',
        label: 'Repos',
        icon: <FolderGitIcon />,
      },
    ],
  },
];

// SidebarNav is fully controlled — same stateful-wrapper pattern the other demos in
// galleryStories.tsx use — so clicking an item actually moves the active fill.
function SidebarNavDemo() {
  const [activeId, setActiveId] = useState('inbox');
  return (
    <SidebarNav
      header={
        <button
          type="button"
          className="rounded-control hover:bg-surface-hover mb-1 flex w-full items-center gap-2.5 p-1.5 text-left transition-colors duration-100"
        >
          <span className="bg-foreground text-background flex size-8 shrink-0 items-center justify-center rounded-[8px] text-[13px] font-semibold">
            D
          </span>
          <span className="min-w-0 flex-1">
            <span className="text-foreground block truncate text-[13px] leading-tight font-medium">
              Dispatch
            </span>
            <span className="text-muted-foreground block truncate text-[11px] leading-tight">
              Production workspace
            </span>
          </span>
          <ChevronsUpDownIcon
            aria-hidden
            className="text-muted-foreground size-3"
          />
        </button>
      }
      sections={SIDEBAR_SECTIONS}
      activeId={activeId}
      onSelect={setActiveId}
      footer={
        <div className="text-muted-foreground px-2 pt-1 font-mono text-[11px] tabular-nums">
          v0.14.0
        </div>
      }
    />
  );
}

export const sidebarNavStories: GalleryStory[] = [
  {
    id: 'sidebar-nav-workspace',
    title: 'Sidebar nav — workspace',
    note: 'Dispatch-shaped nav: workspace switcher header, Board/Inbox (attention dot, count 3), Plans/All agents/Repos. Active item is a flat neutral fill, not accent — click an item to move it.',
    render: () => <SidebarNavDemo />,
  },
];
