import type { KeyboardEvent, ReactNode } from 'react';

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

// Spelled out because Tailwind cannot build class names at runtime. Maps the row's own
// state vocabulary onto the shared run-state palette: `running`→working, `done`→review,
// `queued`→ready (the brief's mapping, not a 1:1 name match with the token suffixes).
const DOT_CLASS: Record<TaskRowState, string> = {
  running: 'bg-state-working',
  waiting: 'bg-state-waiting',
  failed: 'bg-state-failed',
  done: 'bg-state-review',
  queued: 'bg-state-ready',
};

/** One dense row in a task/run list: a state dot (pulsing while `running`), the
 * task's title and agent, a `detail` line that shimmers while running, an optional
 * `progress` caption, a trailing mono `elapsedLabel`, and a hover-revealed `actions`
 * slot. Failed rows get a soft red wash. Renders as a clickable row (keyboard
 * operable) when `onClick` is given, a static row otherwise — `actions`, if any,
 * stays a sibling rather than nesting inside it, so callers can put real `<button>`s
 * there without an invalid button-in-button. Matches the showcase's "Task Rows"
 * primitive, adapted to the run-state token model. */
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
  const isFailed = state === 'failed';
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
      className={`group/row ease-out-expo flex items-center gap-2.5 px-3 py-2 transition-colors duration-100 ${
        isFailed ? 'bg-[var(--red-bg)]/50' : ''
      } ${interactive ? 'hover:bg-surface-hover cursor-pointer' : ''}`}
    >
      <span
        aria-hidden
        className={`size-2 shrink-0 rounded-full ${DOT_CLASS[state]} ${
          isRunning ? 'motion-safe:animate-pulse' : ''
        }`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-foreground truncate text-[13px] font-medium">
            {title}
          </span>
          <span className="text-muted-foreground shrink-0 text-[11.5px]">
            {agent}
          </span>
        </div>
        {detail !== undefined &&
          (isRunning ? (
            <ShimmerLabel className="block truncate">{detail}</ShimmerLabel>
          ) : (
            <p className="text-muted-foreground truncate text-[12px]">
              {detail}
            </p>
          ))}
      </div>
      {progress !== undefined && (
        <span className="text-muted-foreground shrink-0 font-mono text-[11.5px] tabular-nums">
          {progress}
        </span>
      )}
      {elapsedLabel !== undefined && (
        <span className="text-muted-foreground shrink-0 font-mono text-[12px] tabular-nums">
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
