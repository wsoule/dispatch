import type { RunMeta } from '@dispatch/client';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';

import { modelLabel } from '../../../lib/models';
import { runKindLabel } from '../../../lib/runKind';
import { isTerminalRunState } from '../../../lib/runState';
import { formatShortDate } from '../../../lib/taskDates';
import { RunStatePill } from '../../runs/RunStatePill';
import { Pill, SelectPill } from '@/ui/ai/pill';
import { formatElapsed, useElapsed } from '@/ui/ai/use-elapsed';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';

function LiveElapsed({ since }: { since: string }) {
  const label = useElapsed(Date.parse(since));
  return <>{label}</>;
}

/** How long a run took, or has taken so far — ticking while it is live. */
function Duration({ run }: { run: RunMeta }) {
  if (!isTerminalRunState(run.state))
    return <LiveElapsed since={run.createdAt} />;
  const ms = Date.parse(run.updatedAt) - Date.parse(run.createdAt);
  return <>{Number.isNaN(ms) ? '—' : formatElapsed(ms)}</>;
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span
      className="font-book flex items-baseline gap-1 text-[12px] tabular-nums"
      title={label}
    >
      <span className="text-(--text-secondary)">{children}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

/** A run's id, with its kind after it when it only checked the work (review, verify). */
function RunName({ run }: { run: RunMeta }) {
  return (
    <>
      <span className="truncate tracking-(--id-tracking)">{run.id}</span>
      {(run.kind ?? 'execute') !== 'execute' && (
        <span className="text-muted-foreground shrink-0">
          {runKindLabel(run.kind)}
        </span>
      )}
    </>
  );
}

/** Which run the Run and Review modes show, when the task has had more than one. */
function RunPicker({
  runs,
  selected,
  onSelect,
}: {
  runs: RunMeta[];
  selected: RunMeta;
  onSelect: (runId: string) => void;
}) {
  if (runs.length < 2) {
    return (
      <span className="text-muted-foreground font-book flex min-w-0 items-center gap-1.5 text-[12px]">
        <RunName run={selected} />
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<SelectPill aria-label="Run" className="max-w-56" />}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <RunName run={selected} />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {runs.map((r) => (
          <DropdownMenuItem key={r.id} onClick={() => onSelect(r.id)}>
            <RunStatePill meta={r} compact />
            <span className="font-book flex min-w-0 flex-1 items-center gap-1.5 text-[13px]">
              <RunName run={r} />
            </span>
            <span className="text-muted-foreground font-book text-[12px]">
              {formatShortDate(r.updatedAt)}
            </span>
            {r.id === selected.id && <Check className="size-3" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The run's vitals on one 32px line above the Run and Review modes: its state, who is
 * running it on which model, which run (a picker once there are several), how long it has
 * taken — ticking while live — what it has cost, and its turns. `actions` sits at the
 * right edge (Stop, the review verdict).
 */
export function RunStrip({
  run,
  runs,
  onSelectRun,
  detail,
  actions,
}: {
  run: RunMeta;
  runs: RunMeta[];
  onSelectRun: (runId: string) => void;
  /** One more fact after the vitals (the review's diff size). */
  detail?: ReactNode;
  actions?: ReactNode;
}) {
  const model = modelLabel(run.model);
  return (
    <div
      data-slot="run-strip"
      className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1"
    >
      <RunStatePill meta={run} />
      <span className="font-book truncate text-[12px] text-(--text-secondary)">
        {run.executor}
        {model !== undefined && (
          <span className="text-muted-foreground"> · {model}</span>
        )}
      </span>
      <RunPicker runs={runs} selected={run} onSelect={onSelectRun} />
      <Stat label="elapsed">
        <Duration run={run} />
      </Stat>
      {run.costUsd !== undefined && (
        <Stat label="spent">${run.costUsd.toFixed(2)}</Stat>
      )}
      {run.turns !== undefined && <Stat label="turns">{run.turns}</Stat>}
      {detail}
      {actions !== undefined && (
        <div className="ml-auto flex items-center gap-1.5">{actions}</div>
      )}
    </div>
  );
}

/** The files a run has claimed so far — seeded from the task's writes, grown from its
 * worktree — as mono pills, the first few shown. */
export function FilesTouched({ files }: { files: readonly string[] }) {
  if (files.length === 0) return null;
  const shown = files.slice(0, 8);
  return (
    <div
      data-slot="files-touched"
      className="flex min-w-0 flex-wrap items-center gap-1"
      aria-label="Files touched"
    >
      <span className="text-muted-foreground mr-1 text-[12px] font-medium">
        Files
      </span>
      {shown.map((f) => (
        <Pill key={f} className="max-w-64 font-mono font-normal" title={f}>
          <span className="truncate">{f}</span>
        </Pill>
      ))}
      {files.length > shown.length && (
        <span className="text-muted-foreground font-book text-[12px]">
          +{files.length - shown.length} more
        </span>
      )}
    </div>
  );
}
