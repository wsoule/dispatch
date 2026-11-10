import type { EffortLevel } from '@dispatch-foo/core/browser';
import type { ExecutorsResponse } from '@dispatch/client';
import {
  Button,
  cx,
  Kbd,
  type PickerOption,
  PickerPopover,
  type UiTone,
} from '@dispatch/ui';
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
import styles from './DispatchCard.module.css';

/** The card's state: what dispatching would do right now (`data-state` on the card). */
type CardState = 'ready' | 'warn' | 'blocked' | 'live' | 'closed';

// Each state's status colour. Blocked is amber (a missing input, not a failure).
const CARD_TONE: Record<CardState, UiTone> = {
  ready: 'success',
  warn: 'warning',
  blocked: 'warning',
  live: 'info',
  closed: 'muted',
};

const CHECK_ICON: Record<CheckTone, typeof Check> = {
  pass: Check,
  warn: TriangleAlert,
  block: CircleSlash,
  pending: Loader2,
};

// A check's status colour. Warn and block share amber; the glyph (a triangle or a slashed
// circle) and the words tell them apart.
const CHECK_TONE: Record<CheckTone, UiTone> = {
  pass: 'success',
  warn: 'warning',
  block: 'warning',
  pending: 'muted',
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

/** The card's state, in the order the headline reads it. */
function cardState(readiness: DispatchReadiness, live: boolean): CardState {
  if (live) return 'live';
  if (readiness.closed) return 'closed';
  if (readiness.blocked) return 'blocked';
  return readiness.warnings > 0 ? 'warn' : 'ready';
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
  const Icon = CHECK_ICON[check.tone];
  return (
    <li
      data-slot="readiness-check"
      data-check={check.id}
      data-state={check.tone}
      data-tone={CHECK_TONE[check.tone]}
      className={styles.check}
    >
      <Icon
        aria-hidden
        size={14}
        strokeWidth={1.8}
        className={styles.checkIcon}
      />
      <span className={styles.checkLabel}>{check.label}</span>
      {check.taskIds?.slice(0, 3).map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onOpenTask(id)}
          className={cx(styles.taskLink, 'mono')}
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

// The model picker's choices: every known model id under its label.
const MODEL_OPTIONS: readonly PickerOption[] = MODELS.map((m) => ({
  value: m.id,
  label: m.label,
}));

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
  const executorOptions = useMemo<PickerOption[]>(
    () => choices.map((e) => ({ value: e.name, label: e.name })),
    [choices]
  );
  const effortChoices = efforts.map((e) => ({ value: e.id, label: e.label }));
  const runsOn = executor ?? executors?.default ?? 'claude';
  const state = cardState(readiness, live);

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
      data-state={state}
      data-tone={CARD_TONE[state]}
      aria-label="Dispatch"
      className={styles.card}
    >
      {/* The headline keeps a readable width; the pickers wrap below it
          in a narrow pane instead of squeezing it to a word per line. */}
      <div className={styles.head}>
        <p className={styles.headline}>{headline(readiness, live, starting)}</p>
        {live ? (
          <Button
            size="sm"
            variant="primary"
            icon={<SquareTerminal size={14} strokeWidth={1.8} aria-hidden />}
            onClick={onOpenRun}
          >
            Open run
          </Button>
        ) : (
          <div className={styles.controls}>
            {choices.length > 1 && (
              <PickerPopover
                label="Executor"
                appearance="mono"
                searchable={false}
                align="end"
                options={executorOptions}
                value={runsOn}
                onChange={(next) =>
                  // Picking the daemon's default sends none, as an untouched picker does.
                  setExecutor(
                    next === null || next === executors?.default
                      ? undefined
                      : next
                  )
                }
              />
            )}
            {runsOn === 'claude' && (
              <PickerPopover
                label="Model"
                appearance="mono"
                searchable={false}
                align="end"
                options={MODEL_OPTIONS}
                value={model}
                valueLabel={modelLabel(model)}
                onChange={(next) => {
                  if (next !== null) setModel(next);
                }}
              />
            )}
            {runsOn === 'claude' && (
              <PickerPopover
                label="Effort"
                appearance="quiet"
                searchable={false}
                align="end"
                options={effortChoices}
                value={effortId}
                onChange={(next) => {
                  if (next !== null) setEffortId(next);
                }}
              />
            )}
            {isFakeExecutorDevToolEnabled() && runsOn !== 'fake' && (
              <Button
                size="sm"
                variant="quiet"
                disabled={starting}
                onClick={() => dispatch('fake')}
              >
                Dispatch (fake)
              </Button>
            )}
            <Button
              size="sm"
              variant={readiness.blocked ? 'secondary' : 'primary'}
              disabled={starting || !readiness.canDispatch}
              onClick={() => dispatch()}
              iconAfter={
                dispatchesOnKey(readiness) ? (
                  <Kbd className={styles.kbd}>D</Kbd>
                ) : undefined
              }
            >
              {readiness.blocked ? 'Dispatch anyway' : 'Dispatch'}
              {/* The keycap is visual (iconAfter is aria-hidden); the name carries the key. */}
              {dispatchesOnKey(readiness) && (
                <span className="srOnly"> (D)</span>
              )}
            </Button>
          </div>
        )}
      </div>
      <ul className={styles.checks}>
        {readiness.checks.map((check) => (
          <CheckChip
            key={check.id}
            check={check}
            onOpenTask={onOpenTask}
            action={
              check.id === 'spec' &&
              check.tone === 'warn' &&
              onEnrich !== undefined ? (
                <Button
                  size="sm"
                  variant="quiet"
                  className={styles.fix}
                  disabled={enriching}
                  icon={<Sparkles size={14} strokeWidth={1.8} aria-hidden />}
                  onClick={onEnrich}
                >
                  {enriching ? 'Reading the repo…' : 'Add detail'}
                </Button>
              ) : check.id === 'writes' && check.tone === 'warn' ? (
                <Button
                  size="sm"
                  variant="quiet"
                  className={styles.fix}
                  onClick={onAddWrites}
                >
                  Declare
                </Button>
              ) : undefined
            }
          />
        ))}
      </ul>
    </section>
  );
}
