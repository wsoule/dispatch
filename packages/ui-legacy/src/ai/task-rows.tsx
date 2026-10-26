import type { KeyboardEvent, ReactNode } from 'react';

import { StateMark } from '../chrome/state-mark';
import type { FeedState } from '../lib/feedState';
import { ShimmerLabel } from './shimmer';

export type TaskRowState = 'running' | 'waiting' | 'failed' | 'done' | 'queued';

export type TaskRowProps = {
  title: string;
  agent: string;
  state: TaskRowState;
  detail?: string;
  progress?: string;
  elapsedLabel?: string;
  onClick?: () => void;
  actions?: ReactNode;
};

// Maps the row's own state vocabulary onto the feed states `StateMark` draws:
// `running`→working, `done`→review, `queued`→ready (the brief's mapping, not a 1:1
// name match).
const MARK_STATE: Record<TaskRowState, FeedState> = {
  running: 'working',
  waiting: 'answer',
  failed: 'failed',
  done: 'review',
  queued: 'ready',
};

/** One 36px row in a task/run list (`min-h-9`; both text lines sit on a 16px leading
 * so a title + `detail` pair still fits the 36px box): a 14px `StateMark`, the task's
 * title and agent, a `detail` line that shimmers while running, an optional `progress`
 * caption, a trailing `elapsedLabel`, and a hover-revealed `actions` slot. No wash on
 * failed rows — the red mark carries it. Renders as a clickable row (keyboard operable)
 * when `onClick` is given, a static row otherwise — `actions`, if any, stays a sibling
 * rather than nesting inside it, so callers can put real `<button>`s there without an
 * invalid button-in-button. */
export function TaskRow({
  title,
  agent,
  state,
  detail,
  progress,
  elapsedLabel,
  onClick,
  actions,
}: TaskRowProps) {
  const isRunning = state === 'running';
  const interactive = onClick !== undefined;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!onClick) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick();
    }
  }

  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={interactive ? handleKeyDown : undefined}
      className={`group/row ease-out-expo flex min-h-9 items-center gap-2.5 px-3 transition-colors duration-100 ${
        interactive ? 'hover:bg-surface-hover cursor-pointer' : ''
      }`}
    >
      <StateMark state={MARK_STATE[state]} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 leading-4">
          <span className="text-foreground truncate text-[13px] font-medium">
            {title}
          </span>
          <span className="text-muted-foreground font-book shrink-0 text-[12px]">
            {agent}
          </span>
        </div>
        {detail !== undefined &&
          (isRunning ? (
            <ShimmerLabel className="font-book block truncate text-[12px] leading-4">
              {detail}
            </ShimmerLabel>
          ) : (
            <p className="text-muted-foreground font-book truncate text-[12px] leading-4">
              {detail}
            </p>
          ))}
      </div>
      {progress !== undefined && (
        <span className="text-muted-foreground font-book shrink-0 text-[12px] tabular-nums">
          {progress}
        </span>
      )}
      {elapsedLabel !== undefined && (
        <span className="text-muted-foreground font-book shrink-0 text-[12px] tabular-nums">
          {elapsedLabel}
        </span>
      )}
      {actions !== undefined && (
        <div className="ease-out-expo flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 group-focus-within/row:opacity-100 group-hover/row:opacity-100">
          {actions}
        </div>
      )}
    </div>
  );
}

export type TaskRowListProps = {
  children: ReactNode;
};

/** Frame for a stack of `TaskRow`s: a card surface with a hairline divider between
 * each row — `shadow-hairline-top` on every row but the first, an inset box-shadow
 * rather than a layout-affecting border. Matches the showcase's "Task Rows" list
 * frame. */
export function TaskRowList({ children }: TaskRowListProps) {
  return (
    <div className="bg-card rounded-card shadow-card [&>*+*]:shadow-hairline-top overflow-hidden">
      {children}
    </div>
  );
}
