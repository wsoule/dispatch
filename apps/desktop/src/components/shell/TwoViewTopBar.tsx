import type { ReactNode } from 'react';

import type { OrbState } from '../../lib/agentPresence';
import type { MainView } from '../../lib/twoViews';
import { Orb } from './Orb';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

// A page word: secondary at rest, lifted onto the active fill while its page is open.
const NAV_WORD =
  'text-(--text-secondary) hover:bg-surface-control hover:text-foreground aria-[current=page]:bg-surface-active aria-[current=page]:text-foreground aria-expanded:bg-surface-active aria-expanded:text-foreground';

/** The four counts on "tasks", each its own click target; a zero shows a muted 0. */
type TopCount = 'asks' | 'review' | 'failed' | 'working';

interface TopCounts {
  asks: number;
  review: number;
  failed: number;
  working: number;
}

const COUNT: Record<TopCount, { glyph: string; tone: string; label: string }> =
  {
    asks: {
      glyph: '●',
      tone: 'text-(--state-waiting-fg)',
      label: 'waiting on you',
    },
    review: {
      glyph: '◇',
      tone: 'text-(--state-review-fg)',
      label: 'ready for review',
    },
    failed: { glyph: '✕', tone: 'text-(--state-failed-fg)', label: 'failed' },
    working: {
      glyph: '◐',
      tone: 'text-(--state-working-fg)',
      label: 'working',
    },
  };

const ORDER: readonly TopCount[] = ['asks', 'review', 'failed', 'working'];

export interface TwoViewTopBarProps {
  view: MainView;
  orb: OrbState;
  orbLabel: string;
  postsDot: boolean;
  onShowOverseer: () => void;
  onShowTasks: () => void;
  onCount: (count: TopCount) => void;
  counts: TopCounts;
  /** Admin items with no other home; muted, never amber. */
  settingsCount: number;
  /** What those items are, for the link's tooltip. */
  settingsTitle?: string;
  onOpenSettings: () => void;
  settingsOpen: boolean;
  /** The docs and threads pages under Tasks; `page` says which one is open. */
  onOpenDocs: () => void;
  onOpenThreads: () => void;
  /** Unread messages to you, beside "threads"; muted, never amber. */
  threadsUnread: number;
  page: 'docs' | 'threads' | null;
  /** The project menu under the orb ("dispatch ▾"). */
  projectMenu: ReactNode;
  trafficLightInset: boolean;
}

// "settings", with its muted admin count and, when there is one, a tooltip naming them.
function SettingsWord({
  count,
  title,
  open,
  onOpen,
}: {
  count: number;
  title: string | undefined;
  open: boolean;
  onOpen: () => void;
}) {
  const button = (
    <Button
      variant="ghost"
      size="sm"
      onClick={onOpen}
      aria-expanded={open}
      data-testid="two-views-settings"
      className={NAV_WORD}
    >
      settings
      {count > 0 && (
        <span className="text-muted-foreground font-normal"> ·{count}</span>
      )}
    </Button>
  );
  if (title === undefined || title === '') return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side="bottom">{title}</TooltipContent>
    </Tooltip>
  );
}

/** Two views' top bar: the drag region, the orb and project menu, the counts and settings. */
export function TwoViewTopBar({
  view,
  orb,
  orbLabel,
  postsDot,
  onShowOverseer,
  onShowTasks,
  onCount,
  counts,
  settingsCount,
  onOpenDocs,
  onOpenThreads,
  threadsUnread,
  page,
  settingsTitle,
  onOpenSettings,
  settingsOpen,
  projectMenu,
  trafficLightInset,
}: TwoViewTopBarProps) {
  return (
    <header
      data-tauri-drag-region
      data-testid="two-views-top-bar"
      className={cn(
        'grid h-[80px] shrink-0 grid-cols-[1fr_auto_1fr] items-center pr-4',
        trafficLightInset ? 'pl-[84px]' : 'pl-4'
      )}
    >
      <span data-tauri-drag-region />
      <div className="flex flex-col items-center gap-0.5">
        <Orb
          state={orb}
          label={orbLabel}
          postsDot={postsDot && view === 'tasks'}
          onClick={onShowOverseer}
          active={view === 'overseer'}
        />
        {projectMenu}
      </div>
      <nav
        aria-label="Two views"
        className="flex items-center justify-end gap-1"
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={onShowTasks}
          aria-current={view === 'tasks' && page === null ? 'page' : undefined}
          data-testid="two-views-tasks"
          className={NAV_WORD}
        >
          tasks
        </Button>
        <div className="mr-2 flex items-center">
          {ORDER.map((key) => {
            const value = counts[key];
            const spec = COUNT[key];
            const label = `${value} ${spec.label}`;
            return (
              <Tooltip key={key}>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => onCount(key)}
                      aria-label={label}
                      data-testid={`two-views-count-${key}`}
                      className={cn(
                        'hover:bg-surface-control tabular-nums',
                        value > 0
                          ? cn(spec.tone, 'font-semibold')
                          : 'font-normal text-(--text-ghost)'
                      )}
                    />
                  }
                >
                  {spec.glyph} {value}
                </TooltipTrigger>
                <TooltipContent side="bottom">{label}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenDocs}
          aria-current={page === 'docs' ? 'page' : undefined}
          data-testid="two-views-docs"
          className={NAV_WORD}
        >
          docs
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenThreads}
          aria-current={page === 'threads' ? 'page' : undefined}
          data-testid="two-views-threads"
          className={NAV_WORD}
        >
          threads
          {threadsUnread > 0 && (
            <span className="text-muted-foreground font-normal tabular-nums">
              {' '}
              ·{threadsUnread}
            </span>
          )}
        </Button>
        <SettingsWord
          count={settingsCount}
          title={settingsTitle}
          open={settingsOpen}
          onOpen={onOpenSettings}
        />
      </nav>
    </header>
  );
}
