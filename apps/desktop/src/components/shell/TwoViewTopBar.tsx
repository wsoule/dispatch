import type { ReactNode } from 'react';

import type { OrbState } from '../../lib/agentPresence';
import type { MainView } from '../../lib/twoViews';
import { Orb } from './Orb';
import { cn } from '@/lib/utils';

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
  onOpenSettings: () => void;
  settingsOpen: boolean;
  /** The project menu under the orb ("dispatch ▾"). */
  projectMenu: ReactNode;
  trafficLightInset: boolean;
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
        'grid h-[68px] shrink-0 grid-cols-[1fr_auto_1fr] items-center pr-4',
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
        className="flex items-center justify-end gap-4 text-[13px]"
      >
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onShowTasks}
            aria-current={view === 'tasks' ? 'page' : undefined}
            data-testid="two-views-tasks"
            className={cn(
              'rounded-control px-1 text-(--text-primary) outline-none hover:underline focus-visible:underline',
              view === 'tasks' && 'font-semibold underline underline-offset-4'
            )}
          >
            tasks
          </button>
          {ORDER.map((key) => {
            const value = counts[key];
            const spec = COUNT[key];
            return (
              <button
                key={key}
                type="button"
                onClick={() => onCount(key)}
                aria-label={`${value} ${spec.label}`}
                title={`${value} ${spec.label}`}
                data-testid={`two-views-count-${key}`}
                className={cn(
                  'rounded-control px-0.5 font-semibold tabular-nums outline-none hover:underline focus-visible:underline',
                  value > 0 ? spec.tone : 'font-normal text-(--text-ghost)'
                )}
              >
                {spec.glyph} {value}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-expanded={settingsOpen}
          data-testid="two-views-settings"
          className={cn(
            'rounded-control px-1 text-(--text-primary) outline-none hover:underline focus-visible:underline',
            settingsOpen && 'font-semibold'
          )}
        >
          settings
          {settingsCount > 0 && (
            <span className="text-muted-foreground font-normal">
              {' '}
              ·{settingsCount}
            </span>
          )}
        </button>
      </nav>
    </header>
  );
}
