import type { OrbState, OrbTone } from '../../lib/agentPresence';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

// Ring and core colours per tone, from the shared state tokens.
const RING: Record<OrbTone, string> = {
  off: 'border-dashed border-(--text-ghost) bg-(--surface-muted)',
  broken: 'border-(--state-failed-fg) bg-(--state-failed-surface)',
  amber: 'border-(--state-waiting-fg) bg-(--state-waiting-surface)',
  green: 'border-(--state-review-fg) bg-(--state-review-surface)',
  motion: 'border-(--state-working-fg) bg-(--state-working-surface)',
  idle: 'border-border-strong bg-background',
};

const CORE: Record<OrbTone, string> = {
  off: 'hidden',
  broken: 'hidden',
  amber: 'inset-[6px] bg-(--state-waiting-fg)',
  green: 'inset-[6px] bg-(--state-review-fg)',
  motion: 'inset-[8px] bg-(--state-working-fg)',
  idle: 'inset-[8px] bg-(--text-ghost)',
};

const BADGE: Partial<Record<OrbTone, string>> = {
  amber: 'bg-(--state-waiting-fg)',
  green: 'bg-(--state-review-fg)',
};

export interface OrbProps {
  state: OrbState;
  /** The tooltip and accessible name: every count the orb stands for. */
  label: string;
  /** Unread "For you" posts: a dot, never a number. */
  postsDot?: boolean;
  onClick: () => void;
  active: boolean;
}

/** The Overseer: one agent, one state at a time. Clicking it shows Overseer. */
export function Orb({ state, label, postsDot, onClick, active }: OrbProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            data-testid="two-views-orb"
            data-tone={state.tone}
            onClick={onClick}
          />
        }
      >
        <span aria-hidden className="relative size-[30px]">
          <span
            className={cn(
              'absolute inset-0 rounded-full border-2',
              RING[state.tone],
              state.spinning && 'animate-spin border-t-transparent'
            )}
          />
          <span className={cn('absolute rounded-full', CORE[state.tone])} />
          {state.tone === 'off' && (
            <span className="absolute top-[3px] left-[14px] h-6 w-[1.5px] rotate-45 bg-(--text-secondary)" />
          )}
          {state.tone === 'broken' && (
            <span className="absolute inset-0 flex items-center justify-center text-[13px] font-bold text-(--state-failed-fg)">
              !
            </span>
          )}
          {state.count !== null && (
            <span
              data-testid="two-views-orb-count"
              className={cn(
                'absolute -top-1 -right-2.5 min-w-[18px] rounded-full px-1 text-center text-[11px] leading-[18px] font-semibold text-white',
                BADGE[state.tone]
              )}
            >
              {state.count}
            </span>
          )}
          {postsDot === true && (
            <span
              data-testid="two-views-orb-posts"
              className="absolute -bottom-px -left-px size-1.5 rounded-full bg-(--accent)"
            />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
