import type { DiffResult, RunMeta } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core';

import { SectionLabel } from '../ui/SectionLabel';
import { formatRelativeTimeFromIso } from '@/lib/format';
import { cn } from '@/lib/utils';

interface RunSidebarProps {
  meta: RunMeta;
  diff: DiffResult | undefined;
  task: TaskDoc | undefined;
  epicTitle: string | null;
  onOpenTask: (taskId: string) => void;
}

/**
 * What this run has actually done, beside its transcript.
 *
 * Three questions, in the order you ask them: what did it touch, what was it meant to be doing,
 * and what has it cost. Notably absent is a completion percentage — the mockup had one, but the
 * orchestrator has no idea how far through a task an agent is, and a bar that advances on turn
 * count would look like measurement while being decoration. Spend and turns are real, so those
 * are what this reports.
 */
export function RunSidebar({
  meta,
  diff,
  task,
  epicTitle,
  onOpenTask,
}: RunSidebarProps) {
  const files = diff?.files ?? [];

  return (
    <div className="flex w-64 shrink-0 flex-col gap-5 overflow-y-auto">
      <div>
        <SectionLabel count={files.length}>Files touched</SectionLabel>
        {files.length === 0 ? (
          <p className="text-muted-foreground mt-1.5 text-[12px]">
            Nothing changed yet.
          </p>
        ) : (
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {files.map((f) => (
              <li key={f.path} className="flex items-center gap-2">
                {/* Truncates from the left so the filename — the part you actually read —
                    survives on a deep path. */}
                <span
                  dir="rtl"
                  className="dense-meta min-w-0 flex-1 truncate text-left"
                  title={f.path}
                >
                  {f.path}
                </span>
                {/* The mockup showed per-file +/- counts. DiffFile carries only a path and a
                    git status — the counts would have to be parsed back out of the patch, and
                    a number invented here would be indistinguishable from a real one. The
                    status is what we actually know. */}
                <span
                  className={cn(
                    'dense-meta',
                    f.status === 'A' && 'text-state-review',
                    f.status === 'D' && 'text-state-failed'
                  )}
                >
                  {f.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <SectionLabel>Task</SectionLabel>
        <button
          type="button"
          onClick={() => onOpenTask(meta.taskId)}
          className="hover:text-accent-foreground mt-1.5 text-left text-[12.5px] leading-relaxed"
        >
          {task?.meta.title ?? meta.taskTitle}
        </button>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="dense-meta">{meta.taskId}</span>
          {epicTitle !== null && (
            <span className="dense-meta truncate">· {epicTitle}</span>
          )}
        </div>
      </div>

      <div>
        <SectionLabel>Run</SectionLabel>
        <dl className="mt-1.5 flex flex-col gap-1">
          <Row label="branch" value={meta.branch} mono title={meta.branch} />
          <Row
            label="started"
            value={formatRelativeTimeFromIso(meta.createdAt)}
          />
          {meta.turns !== undefined && (
            <Row label="turns" value={String(meta.turns)} />
          )}
          {meta.costUsd !== undefined && (
            <Row label="spend" value={`$${meta.costUsd.toFixed(2)}`} />
          )}
          {meta.model !== undefined && <Row label="model" value={meta.model} />}
        </dl>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-muted-foreground w-14 shrink-0 text-[11px]">
        {label}
      </dt>
      <dd
        className={cn(
          'min-w-0 flex-1 truncate text-[12px]',
          mono && 'dense-meta'
        )}
        title={title}
      >
        {value}
      </dd>
    </div>
  );
}
