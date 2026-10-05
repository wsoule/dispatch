import {
  MAX_CONCURRENCY_HARD_CAP,
  type TaskListItem,
} from '@dispatch-foo/core/browser';
import { Zap } from 'lucide-react';
import { type ChangeEvent, useId, useMemo, useState } from 'react';

import {
  buildDispatchPreview,
  DEFAULT_RUN_COST_USD,
  type LiveClaim,
} from '@/lib/dispatchPreview';
import { concurrencyChoices } from '@/lib/epicConcurrency';
import {
  defaultMaxRuns,
  defaultSpendCeiling,
  type WorkEpicOptions,
} from '@/lib/epicSession';
import { cn } from '@/lib/utils';
import { ListRow } from '@/ui/ai/list-row';
import { Pill, PillButton } from '@/ui/ai/pill';
import { Button } from '@/ui/button';
import { HintText } from '@/ui/chrome';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Input } from '@/ui/input';
import { ScrollArea } from '@/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

interface DispatchDialogProps {
  /** What the user selected — every one of these appears in the preview. */
  tasks: TaskListItem[];
  readyIds: ReadonlySet<string>;
  /** Agents already working, which is what eats into the concurrency budget. */
  runningNow: number;
  /** Live runs and their claimed files, so the preview can warn before this dispatch
   * lands on someone else's work. Optional: without it no overlap is checked. */
  liveClaims?: LiveClaim[];
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
  confirmLabel?: string;
  title: string;
  onConfirm: (opts: WorkEpicOptions) => Promise<void>;
  onCancel: () => void;
}

const DISPOSITION_LABEL = {
  'starts-now': 'Starts now',
  queued: 'Queued',
  'not-ready': 'Cannot start',
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
 * Confirms a fan-out by showing exactly what it will do.
 *
 * The reason this is a dialog rather than a button: concurrency is bounded, so dispatching
 * twelve tasks at a concurrency of eight does not start twelve agents. Every selected task is
 * listed and badged — starting now, queued, or un-startable — because the failure this exists to
 * prevent is silently dropping four of them and reporting success. The spend and run
 * ceilings sit next to the concurrency because together they bound what the session may
 * cost, and the estimate line prices the plan against them before anything starts.
 *
 * The concurrency is editable here rather than fixed, since it is chosen per dispatch (see
 * handleWorkEpic); changing it updates the preview live, which is the fastest way to understand
 * what the number actually does.
 */
export function DispatchDialog({
  tasks,
  readyIds,
  runningNow,
  liveClaims,
  defaultConcurrency,
  maxConcurrency = MAX_CONCURRENCY_HARD_CAP,
  runCostEstimateUsd = DEFAULT_RUN_COST_USD,
  fixLoopAuto,
  mode = 'start',
  initial,
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

  // 1…cap. The default is clamped to the cap first (config already forbids an
  // `epicConcurrency` above `maxConcurrency`), and the list is keyed on the default rather
  // than the current pick so choosing a lower value can't drop options.
  const concurrencyOptions = useMemo(
    () => concurrencyChoices(clampConcurrency(defaultConcurrency, cap), cap),
    [defaultConcurrency, cap]
  );

  const maxSpendUsd = parseCeiling(spend, 'spend');
  const maxRuns = parseCeiling(runs, 'runs');
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
      }),
    [
      tasks,
      readyIds,
      runningNow,
      concurrency,
      runCostEstimateUsd,
      ceilingUsd,
      liveClaims,
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

  const hints: string[] = [];
  if (preview.undeclaredWrites > 0) {
    const n = preview.undeclaredWrites;
    hints.push(
      `${n} task${n === 1 ? ' declares' : 's declare'} no writes — ${n === 1 ? 'it' : 'they'} will run one at a time`
    );
  }
  // One line per overlap, naming the person when there is one: "wyat's run"
  // tells you who to talk to, a run id tells you where to look.
  for (const overlap of preview.overlaps) {
    const whose =
      overlap.holder === undefined
        ? `run ${overlap.runId}`
        : `${overlap.holder.replace(/^human:/, '')}'s run ${overlap.runId}`;
    hints.push(
      `${overlap.taskTitle} writes files ${whose} has claimed — it will start anyway`
    );
  }
  if (fixLoopAuto !== undefined) {
    hints.push(
      fixLoopAuto
        ? 'Review rounds share these slots (fixLoop.auto is on)'
        : 'Reviews start by hand (fixLoop.auto is off)'
    );
  }
  if (tasks.length >= LARGE_FANOUT_TASKS) {
    hints.push('Large fan-out — the ceiling pauses it, Resume raises it');
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="w-[min(560px,92vw)] max-w-none sm:max-w-none"
      >
        <DialogHeader className="pt-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription
            data-over-ceiling={preview.overCeiling || undefined}
            className={cn(preview.overCeiling && 'text-(--state-waiting-fg)')}
          >
            {raising ? preview.costSummary : preview.summary}
            {preview.overCeiling && ' — above the ceiling'}
          </DialogDescription>
        </DialogHeader>

        {!raising && (
          <div className="flex items-center gap-2 px-4 pt-2">
            <span className="font-book text-muted-foreground text-[13px]">
              Run at most
            </span>
            <Select
              value={String(concurrency)}
              onValueChange={(value) => setConcurrency(Number(value) || 1)}
            >
              <SelectTrigger aria-label="Concurrency" className="min-w-14">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {concurrencyOptions.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {String(n)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="font-book text-muted-foreground text-[13px]">
              at a time
            </span>
          </div>
        )}

        <div className="flex items-center gap-2 px-4 py-2">
          <label
            htmlFor={`${fieldId}-spend`}
            className="flex items-center gap-2"
          >
            <span className="font-book text-muted-foreground text-[13px]">
              Spend ceiling $
            </span>
            <Input
              id={`${fieldId}-spend`}
              type="number"
              inputMode="decimal"
              min={1}
              step="any"
              aria-label="Spend ceiling"
              aria-invalid={spendInvalid || undefined}
              className="w-24"
              value={spend.text}
              onChange={(event) => setSpend(readCeilingField(event))}
            />
          </label>
          <label
            htmlFor={`${fieldId}-runs`}
            className="flex items-center gap-2"
          >
            <span className="font-book text-muted-foreground text-[13px]">
              Max runs
            </span>
            <Input
              id={`${fieldId}-runs`}
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              aria-label="Max runs"
              aria-invalid={runsInvalid || undefined}
              className="w-20"
              value={runs.text}
              onChange={(event) => setRuns(readCeilingField(event))}
            />
          </label>
        </div>

        {hints.length > 0 && (
          <div className="flex flex-col gap-0.5 px-4 pb-2">
            {hints.map((hint) => (
              <HintText key={hint}>{hint}</HintText>
            ))}
          </div>
        )}

        {!raising && (
          <ScrollArea className="max-h-72 px-1">
            <div role="table" aria-label="Tasks to dispatch">
              {preview.rows.map((row) => (
                <ListRow
                  key={row.taskId}
                  id={row.taskId}
                  title={
                    <span
                      className={cn(
                        row.disposition !== 'starts-now' &&
                          'text-muted-foreground'
                      )}
                    >
                      {row.title}
                    </span>
                  }
                  trailing={
                    <Pill
                      data-disposition={row.disposition}
                      className={cn(
                        row.disposition === 'not-ready' && 'text-status-blocked'
                      )}
                    >
                      {DISPOSITION_LABEL[row.disposition]}
                    </Pill>
                  }
                />
              ))}
            </div>
          </ScrollArea>
        )}

        {error !== null && (
          <p role="alert" className="text-red px-4 pt-2 text-[12px]">
            {error}
          </p>
        )}

        <DialogFooter>
          <PillButton onClick={onCancel}>Cancel</PillButton>
          <Button
            disabled={busy || !canConfirm}
            onClick={() => {
              // `canConfirm` already rules out an invalid ceiling; this narrows the type.
              if (maxSpendUsd === 'invalid' || maxRuns === 'invalid') return;
              setBusy(true);
              setError(null);
              void onConfirm({ concurrency, maxSpendUsd, maxRuns })
                .catch((err: unknown) => {
                  // Only an Error carries a message worth showing; anything else stringifies
                  // to "[object Object]", which tells the reader nothing.
                  setError(
                    err instanceof Error ? err.message : 'Dispatch failed.'
                  );
                })
                .finally(() => setBusy(false));
            }}
          >
            <Zap />
            {label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
