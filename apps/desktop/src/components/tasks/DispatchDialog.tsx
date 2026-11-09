import {
  MAX_CONCURRENCY_HARD_CAP,
  type TaskListItem,
} from '@dispatch-foo/core/browser';
import {
  Button,
  Chip,
  cx,
  Field,
  Notice,
  SlideOver,
  TextField,
} from '@dispatch/ui';
import { Zap } from 'lucide-react';
import { type ChangeEvent, useId, useMemo, useRef, useState } from 'react';

import styles from './DispatchDialog.module.css';
import { StatusIcon } from './StatusIcon';
import {
  buildDispatchPreview,
  DEFAULT_RUN_COST_USD,
  type LiveClaim,
} from '@/lib/dispatchPreview';
import { concurrencyChoices } from '@/lib/milestoneConcurrency';
import {
  defaultMaxRuns,
  defaultSpendCeiling,
  type WorkMilestoneOptions,
} from '@/lib/milestoneSession';

interface DispatchDialogProps {
  /** What the user selected — every one of these appears in the preview. */
  tasks: TaskListItem[];
  readyIds: ReadonlySet<string>;
  /** Agents already working, which is what eats into the concurrency budget. */
  runningNow: number;
  /** Live runs and their claimed files, so the preview can warn before this dispatch
   * lands on someone else's work. Optional: without it no overlap is checked. */
  liveClaims?: LiveClaim[];
  /** For a milestone fan-out: who holds each task against the person starting it (core's
   * `fanoutHolder`, `viewerHolderOf` in the app). A teammate's task shows a Teammate chip
   * and is left out of the counts and the estimate, since the fan-out never starts it.
   * Omitted for a hand dispatch of a selection, which starts each task whoever it
   * belongs to. */
  holderOf?: (task: TaskListItem) => string | null;
  /** Starting concurrency, from the project's config. */
  defaultConcurrency: number;
  /** The most agents the picker offers — the project's `orchestrator.maxConcurrency`.
   * Never above the hard cap, even when a caller forgets the config. */
  maxConcurrency?: number;
  /** The per-run midpoint the `$5–15` estimate line is built around. */
  runCostEstimateUsd?: number;
  /** The project's `fixLoop.auto`; when given, the dialog says whether review rounds
   * will share the slots or wait for a hand. */
  fixLoopAuto?: boolean;
  /** `raise` edits the ceilings of a paused session: no task list, and the button only
   * enables once a ceiling has changed. */
  mode?: 'start' | 'raise';
  /** Values to open with — a paused session's current ceilings in `raise` mode. */
  initial?: {
    concurrency?: number;
    maxSpendUsd?: number | null;
    maxRuns?: number | null;
  };
  /** False drops the spend and run ceiling fields and sends both as `null` — the
   * project's `orchestrator.unlimitedSpend`. */
  ceilings?: boolean;
  confirmLabel?: string;
  title: string;
  onConfirm: (opts: WorkMilestoneOptions) => Promise<void>;
  onCancel: () => void;
}

const DISPOSITION_LABEL = {
  'starts-now': 'Starts now',
  queued: 'Queued',
  'not-ready': 'Cannot start',
  teammate: 'Teammate',
} as const;

// Each disposition's chip tone (AGENTS.md status table): starting now is in progress
// (blue), queued is inactive (grey), a task that cannot start is blocked (amber), and a
// teammate's task, which this fan-out leaves alone, is inactive (grey).
const DISPOSITION_TONE = {
  'starts-now': 'info',
  queued: 'muted',
  'not-ready': 'warning',
  teammate: 'muted',
} as const;

// From here the ceiling is what ends the fan-out, not the task list, and the hint says so.
const LARGE_FANOUT_TASKS = 100;

// What a ceiling input holds. A number input reports `''` for text it cannot parse and
// flags it as `badInput`, so the flag travels with the text: an empty field only means
// "no ceiling" when nothing unparseable was typed.
interface CeilingField {
  text: string;
  badInput: boolean;
}

// A ceiling field as the option it sends. Only an empty field lifts the ceiling (`null`);
// anything the daemon would reject — zero, negative, a fractional run count, text — is
// `invalid`, which blocks the confirm rather than silently sending no ceiling.
function parseCeiling(
  field: CeilingField,
  kind: 'spend' | 'runs'
): number | null | 'invalid' {
  if (field.badInput) return 'invalid';
  const trimmed = field.text.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return 'invalid';
  if (kind === 'runs' && !Number.isInteger(parsed)) return 'invalid';
  return parsed;
}

function readCeilingField(event: ChangeEvent<HTMLInputElement>): CeilingField {
  return {
    text: event.target.value,
    badInput: event.target.validity?.badInput ?? false,
  };
}

// The starting field of a ceiling input: an explicit `null` opens it empty.
function ceilingField(
  value: number | null | undefined,
  fallback: number
): CeilingField {
  return {
    text: value === null ? '' : String(value ?? fallback),
    badInput: false,
  };
}

function clampConcurrency(value: number, cap: number): number {
  return Math.min(cap, Math.max(1, Math.floor(value) || 1));
}

/**
 * Confirms a fan-out by showing exactly what it will do, in the library's modal SlideOver
 * (aria-modal, a scrim, Tab kept inside, global keys muted; Escape and the scrim cancel).
 *
 * The reason this is a form rather than a button: concurrency is bounded, so dispatching
 * twelve tasks at a concurrency of eight does not start twelve agents. Every selected task is
 * listed and badged — starting now, queued, or un-startable — because the failure this exists to
 * prevent is silently dropping four of them and reporting success. The spend and run
 * ceilings sit next to the concurrency because together they bound what the session may
 * cost, and the estimate line prices the plan against them before anything starts.
 *
 * The concurrency is editable here rather than fixed, since it is chosen per dispatch (see
 * handleWorkMilestone); changing it updates the preview live, which is the fastest way to understand
 * what the number actually does.
 */
export function DispatchDialog({
  tasks,
  readyIds,
  runningNow,
  liveClaims,
  holderOf,
  defaultConcurrency,
  maxConcurrency = MAX_CONCURRENCY_HARD_CAP,
  runCostEstimateUsd = DEFAULT_RUN_COST_USD,
  fixLoopAuto,
  mode = 'start',
  initial,
  ceilings = true,
  confirmLabel,
  title,
  onConfirm,
  onCancel,
}: DispatchDialogProps) {
  const cap = Math.min(maxConcurrency, MAX_CONCURRENCY_HARD_CAP);
  const [concurrency, setConcurrency] = useState(() =>
    clampConcurrency(initial?.concurrency ?? defaultConcurrency, cap)
  );
  const initialSpend = ceilingField(
    initial?.maxSpendUsd,
    defaultSpendCeiling(tasks.length, runCostEstimateUsd)
  );
  const initialRuns = ceilingField(
    initial?.maxRuns,
    defaultMaxRuns(tasks.length)
  );
  const [spend, setSpend] = useState(initialSpend);
  const [runs, setRuns] = useState(initialRuns);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  // Focus lands on the first field the mode shows: the concurrency, or the spend ceiling
  // when raising a paused session's ceilings.
  const concurrencyRef = useRef<HTMLSelectElement>(null);
  const spendRef = useRef<HTMLInputElement>(null);

  // 1…cap. The default is clamped to the cap first (config already forbids an
  // `milestoneConcurrency` above `maxConcurrency`), and the list is keyed on the default rather
  // than the current pick so choosing a lower value can't drop options.
  const concurrencyOptions = useMemo(
    () => concurrencyChoices(clampConcurrency(defaultConcurrency, cap), cap),
    [defaultConcurrency, cap]
  );

  const maxSpendUsd = ceilings ? parseCeiling(spend, 'spend') : null;
  const maxRuns = ceilings ? parseCeiling(runs, 'runs') : null;
  const spendInvalid = maxSpendUsd === 'invalid';
  const runsInvalid = maxRuns === 'invalid';
  // An invalid ceiling previews as none: the amber cue would be wrong, and the confirm is
  // disabled anyway.
  const ceilingUsd = spendInvalid ? null : maxSpendUsd;

  const preview = useMemo(
    () =>
      buildDispatchPreview({
        tasks,
        readyIds,
        runningNow,
        concurrency,
        runCostEstimateUsd,
        ceilingUsd,
        liveClaims,
        holderOf,
      }),
    [
      tasks,
      readyIds,
      runningNow,
      concurrency,
      runCostEstimateUsd,
      ceilingUsd,
      liveClaims,
      holderOf,
    ]
  );

  const agents = preview.startsNow + preview.queued;
  const raising = mode === 'raise';
  const ceilingChanged =
    spend.text.trim() !== initialSpend.text.trim() ||
    runs.text.trim() !== initialRuns.text.trim();
  const canConfirm =
    !spendInvalid && !runsInvalid && (raising ? ceilingChanged : agents > 0);
  const label =
    confirmLabel ??
    (raising
      ? 'Raise ceiling'
      : `Send ${agents} ${agents === 1 ? 'agent' : 'agents'}`);

  // Each task's status, for the glyph beside its row.
  const statusById = useMemo(
    () => new Map(tasks.map((task) => [task.meta.id, task.meta.status])),
    [tasks]
  );

  const hints: string[] = [];
  if (preview.undeclaredWrites > 0) {
    const n = preview.undeclaredWrites;
    hints.push(
      `${n} task${n === 1 ? ' declares' : 's declare'} no writes — ${n === 1 ? 'it' : 'they'} will run one at a time`
    );
  }
  if (fixLoopAuto !== undefined) {
    hints.push(
      fixLoopAuto
        ? 'Review rounds share these slots (fixLoop.auto is on)'
        : 'Reviews start by hand (fixLoop.auto is off)'
    );
  }
  if (ceilings && tasks.length >= LARGE_FANOUT_TASKS) {
    hints.push('Large fan-out — the ceiling pauses it, Resume raises it');
  }
  // One warning per overlap, naming the person when there is one: "wyat's run"
  // tells you who to talk to, a run id tells you where to look.
  const overlaps = preview.overlaps.map((overlap) => {
    const whose =
      overlap.holder === undefined
        ? `run ${overlap.runId}`
        : `${overlap.holder.replace(/^human:/, '')}'s run ${overlap.runId}`;
    return {
      key: `${overlap.taskId}:${overlap.runId}`,
      text: `${overlap.taskTitle} writes files ${whose} has claimed — it will start anyway`,
    };
  });

  function confirm() {
    // `canConfirm` already rules out an invalid ceiling; this narrows the type.
    if (maxSpendUsd === 'invalid' || maxRuns === 'invalid') return;
    setBusy(true);
    setError(null);
    void onConfirm({ concurrency, maxSpendUsd, maxRuns })
      .catch((err: unknown) => {
        // Only an Error carries a message worth showing; anything else stringifies
        // to "[object Object]", which tells the reader nothing.
        setError(err instanceof Error ? err.message : 'Dispatch failed.');
      })
      .finally(() => setBusy(false));
  }

  return (
    <SlideOver
      open
      modal
      onClose={onCancel}
      title={title}
      data-slot="dispatch-dialog"
      data-mode={mode}
      initialFocusRef={raising ? spendRef : concurrencyRef}
      footer={
        <>
          <Button variant="quiet" onClick={onCancel}>
            Cancel
          </Button>
          {/* Red when even the low estimate clears the spend ceiling: the session will
              pause before every task has run. */}
          <Button
            variant={preview.overCeiling ? 'danger' : 'primary'}
            icon={<Zap size={14} strokeWidth={1.8} />}
            disabled={!canConfirm}
            busy={busy}
            busyLabel={raising ? 'Raising…' : 'Sending…'}
            onClick={confirm}
          >
            {label}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <p
          data-slot="dialog-description"
          data-over-ceiling={preview.overCeiling || undefined}
          data-tone={preview.overCeiling ? 'warning' : undefined}
          className={styles.summary}
        >
          {raising ? preview.costSummary : preview.summary}
          {preview.overCeiling && ' — above the ceiling'}
        </p>

        {/* The failure sits at the top, under the summary: the task list below is
            unbounded (the sheet's body scrolls), so on a large fan-out an alert after it
            would land off-screen and a sighted reader would see nothing happen. */}
        {error !== null && (
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        )}

        <div className={styles.fields}>
          {!raising && (
            <Field label="Concurrency" id={`${fieldId}-concurrency`}>
              {/* A native select, not the library's picker Select: the choice is a plain
                  number list, and a native control keeps role combobox with every option
                  in the DOM (DispatchDialog.test counts them) and saves nothing until
                  the confirm. */}
              <select
                ref={concurrencyRef}
                id={`${fieldId}-concurrency`}
                className={cx('select', styles.concurrency)}
                value={String(concurrency)}
                onChange={(event) =>
                  setConcurrency(Number(event.target.value) || 1)
                }
              >
                {concurrencyOptions.map((n) => (
                  <option key={n} value={String(n)}>
                    {String(n)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {ceilings && (
            <>
              <Field
                label="Spend ceiling"
                id={`${fieldId}-spend`}
                error={
                  spendInvalid
                    ? 'More than $0, or empty for no ceiling'
                    : undefined
                }
              >
                <TextField
                  ref={spendRef}
                  type="number"
                  inputMode="decimal"
                  min={1}
                  step="any"
                  start="$"
                  className={styles.number}
                  value={spend.text}
                  onChange={(event) => setSpend(readCeilingField(event))}
                />
              </Field>
              <Field
                label="Max runs"
                id={`${fieldId}-runs`}
                error={
                  runsInvalid
                    ? 'A whole number above 0, or empty for no ceiling'
                    : undefined
                }
              >
                <TextField
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  className={styles.number}
                  value={runs.text}
                  onChange={(event) => setRuns(readCeilingField(event))}
                />
              </Field>
            </>
          )}
        </div>

        {hints.length > 0 && (
          <ul className={styles.hints}>
            {hints.map((hint) => (
              <li key={hint}>{hint}</li>
            ))}
          </ul>
        )}

        {overlaps.length > 0 && (
          <Notice tone="warning" role="note" label="Claimed files">
            {overlaps.map((overlap) => (
              <p key={overlap.key} className={styles.overlap}>
                {overlap.text}
              </p>
            ))}
          </Notice>
        )}

        {!raising && (
          <ul className={styles.tasks} aria-label="Tasks to dispatch">
            {preview.rows.map((row) => (
              <li
                key={row.taskId}
                data-disposition={row.disposition}
                className={styles.task}
              >
                <StatusIcon status={statusById.get(row.taskId) ?? ''} />
                <span className={styles.taskTitle}>{row.title}</span>
                <span className={styles.taskId}>{row.taskId}</span>
                <Chip tone={DISPOSITION_TONE[row.disposition]}>
                  {DISPOSITION_LABEL[row.disposition]}
                </Chip>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SlideOver>
  );
}
