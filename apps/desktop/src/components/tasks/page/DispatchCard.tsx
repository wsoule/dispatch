import type { EffortLevel } from '@dispatch-foo/core/browser';
import type { ExecutorsResponse } from '@dispatch/client';
import {
  Check,
  CircleSlash,
  Loader2,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import { isFakeExecutorDevToolEnabled } from '../../../lib/devTools';
import type {
  CheckTone,
  DispatchReadiness,
  ReadinessCheck,
} from '../../../lib/dispatchReadiness';
import { dispatchesOnKey } from '../../../lib/dispatchReadiness';
import {
  DEFAULT_EFFORT_ID,
  effortFromId,
  effortOptions,
  modelLabel,
  MODELS,
  readDefaultModel,
} from '../../../lib/models';
import { cn } from '@/lib/utils';
import { PillButton, SelectPill } from '@/ui/ai/pill';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Kbd } from '@/ui/kbd';

const TONE_ICON: Record<CheckTone, typeof Check> = {
  pass: Check,
  warn: TriangleAlert,
  block: CircleSlash,
  pending: Loader2,
};

const TONE_CLASS: Record<CheckTone, string> = {
  pass: 'text-state-review',
  warn: 'text-state-waiting',
  block: 'text-state-failed',
  pending: 'text-muted-foreground animate-spin',
};

/** The sentence that heads the card: what dispatching would do right now. */
function headline(
  readiness: DispatchReadiness,
  live: boolean,
  starting: boolean
): string {
  if (starting) return 'Starting an agent…';
  if (live) return 'An agent is on it';
  if (readiness.closed) return 'Closed: reopen it to dispatch';
  if (readiness.blocked) return 'Waiting on its blockers';
  if (readiness.warnings > 0) {
    return `Ready, with ${readiness.warnings} thing${readiness.warnings === 1 ? '' : 's'} to check`;
  }
  return 'Ready to dispatch';
}

function CheckChip({
  check,
  onOpenTask,
  action,
}: {
  check: ReadinessCheck;
  onOpenTask: (taskId: string) => void;
  action?: ReactNode;
}) {
  const Icon = TONE_ICON[check.tone];
  return (
    <li
      data-slot="readiness-check"
      data-check={check.id}
      data-tone={check.tone}
      className="font-book flex min-w-0 items-center gap-1.5 text-[12px] leading-5 text-(--text-secondary)"
    >
      <Icon
        aria-hidden
        className={cn('size-3.5 shrink-0', TONE_CLASS[check.tone])}
      />
      <span className="truncate">{check.label}</span>
      {check.taskIds?.slice(0, 3).map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onOpenTask(id)}
          className="text-muted-foreground hover:text-foreground shrink-0 tracking-(--id-tracking) underline-offset-2 outline-none hover:underline focus-visible:underline"
        >
          {id}
        </button>
      ))}
      {action}
    </li>
  );
}

export interface DispatchCardProps {
  readiness: DispatchReadiness;
  /** A run of this task is live. */
  live: boolean;
  starting: boolean;
  executors: ExecutorsResponse | undefined;
  /** The model a dispatch runs on when the picker is untouched. */
  defaultModel: string | undefined;
  /** The project's `effort.execute`, named on the effort picker's Default entry. */
  defaultEffort?: EffortLevel;
  onDispatch: (executor?: string, model?: string, effort?: EffortLevel) => void;
  onOpenRun: () => void;
  onOpenTask: (taskId: string) => void;
  /** Starts an AI pass that fills in a thin spec; omitted hides `Add detail`. */
  onEnrich?: () => void;
  enriching: boolean;
  /** Scrolls to the writes editor. */
  onAddWrites: () => void;
}

/**
 * The Spec mode's call to action: a card that says in one line whether the task can go,
 * lists what was checked (blockers, the spec, declared writes, live runs on the same
 * files) with a fix beside each warning, and carries Dispatch with its executor and model.
 * Blockers turn the button into `Dispatch anyway`; a live run turns it into `Open run`.
 */
export function DispatchCard({
  readiness,
  live,
  starting,
  executors,
  defaultModel,
  defaultEffort,
  onDispatch,
  onOpenRun,
  onOpenTask,
  onEnrich,
  enriching,
  onAddWrites,
}: DispatchCardProps) {
  const [model, setModel] = useState(() => defaultModel ?? readDefaultModel());
  // The Default sentinel sends no effort, so the daemon applies the config's.
  const [effortId, setEffortId] = useState(DEFAULT_EFFORT_ID);
  const efforts = effortOptions(defaultEffort);
  // Undefined sends no executor at all: the daemon's default, which a resumable run
  // never refuses for naming one.
  const [executor, setExecutor] = useState<string | undefined>(undefined);
  // The daemon's test-only executors (`fake`, `fake-ask`, …) are never a real choice.
  const choices = useMemo(
    () =>
      (executors?.executors ?? []).filter(
        (e) => e.name !== 'fake' && !e.name.startsWith('fake-')
      ),
    [executors]
  );
  const runsOn = executor ?? executors?.default ?? 'claude';
  const tone = live
    ? 'live'
    : readiness.closed
      ? 'closed'
      : readiness.blocked
        ? 'blocked'
        : readiness.warnings > 0
          ? 'warn'
          : 'ready';

  function dispatch(explicit?: string) {
    const chosen = explicit ?? executor;
    const on = chosen ?? executors?.default ?? 'claude';
    // The model and effort pickers are Claude's; any other executor picks its own.
    onDispatch(
      chosen,
      on === 'claude' ? model : undefined,
      on === 'claude' ? effortFromId(effortId) : undefined
    );
  }

  return (
    <section
      data-slot="dispatch-card"
      data-tone={tone}
      aria-label="Dispatch"
      className={cn(
        'rounded-card border-border-strong bg-surface-quaternary mx-4 flex flex-col gap-2.5 border-[0.5px] px-3.5 py-3',
        tone === 'ready' && 'shadow-[inset_2px_0_0_var(--state-review-fg)]',
        tone === 'warn' && 'shadow-[inset_2px_0_0_var(--state-waiting-fg)]',
        tone === 'blocked' && 'shadow-[inset_2px_0_0_var(--state-failed-fg)]',
        tone === 'live' && 'shadow-[inset_2px_0_0_var(--state-working-fg)]'
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-foreground min-w-0 flex-1 text-[13px] font-semibold">
          {headline(readiness, live, starting)}
        </p>
        {live ? (
          <Button size="sm" onClick={onOpenRun}>
            <SquareTerminal />
            Open run
          </Button>
        ) : (
          <>
            {choices.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<SelectPill aria-label="Executor" />}
                >
                  {runsOn}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {choices.map((e) => (
                    <DropdownMenuItem
                      key={e.name}
                      onClick={() =>
                        setExecutor(
                          e.name === executors?.default ? undefined : e.name
                        )
                      }
                    >
                      <span className="flex-1">{e.name}</span>
                      {e.name === runsOn && (
                        <Check className="ml-auto size-3" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {runsOn === 'claude' && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<SelectPill aria-label="Model" />}>
                  {modelLabel(model)}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {MODELS.map((m) => (
                    <DropdownMenuItem key={m.id} onClick={() => setModel(m.id)}>
                      <span className="flex-1">{m.label}</span>
                      {m.id === model && <Check className="ml-auto size-3" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {runsOn === 'claude' && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<SelectPill aria-label="Effort" />}
                >
                  {efforts.find((e) => e.id === effortId)?.label}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {efforts.map((e) => (
                    <DropdownMenuItem
                      key={e.id}
                      onClick={() => setEffortId(e.id)}
                    >
                      <span className="flex-1">{e.label}</span>
                      {e.id === effortId && (
                        <Check className="ml-auto size-3" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {isFakeExecutorDevToolEnabled() && runsOn !== 'fake' && (
              <PillButton disabled={starting} onClick={() => dispatch('fake')}>
                Dispatch (fake)
              </PillButton>
            )}
            <Button
              size="sm"
              variant={readiness.blocked ? 'secondary' : 'default'}
              disabled={starting || !readiness.canDispatch}
              onClick={() => dispatch()}
            >
              {readiness.blocked ? 'Dispatch anyway' : 'Dispatch'}
              {dispatchesOnKey(readiness) && (
                <Kbd className="bg-primary-foreground/15 text-primary-foreground ml-0.5 border-transparent">
                  D
                </Kbd>
              )}
            </Button>
          </>
        )}
      </div>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {readiness.checks.map((check) => (
          <CheckChip
            key={check.id}
            check={check}
            onOpenTask={onOpenTask}
            action={
              check.id === 'spec' &&
              check.tone === 'warn' &&
              onEnrich !== undefined ? (
                <button
                  type="button"
                  disabled={enriching}
                  onClick={onEnrich}
                  className="text-primary hover:text-foreground flex shrink-0 items-center gap-1 font-medium outline-none focus-visible:underline disabled:opacity-60"
                >
                  <Sparkles className="size-3" />
                  {enriching ? 'Reading the repo…' : 'Add detail'}
                </button>
              ) : check.id === 'writes' && check.tone === 'warn' ? (
                <button
                  type="button"
                  onClick={onAddWrites}
                  className="text-primary hover:text-foreground shrink-0 font-medium outline-none focus-visible:underline"
                >
                  Declare
                </button>
              ) : undefined
            }
          />
        ))}
      </ul>
    </section>
  );
}
