import type { TaskDoc } from '@dispatch/core/browser';
import { Zap } from 'lucide-react';
import { useMemo, useState } from 'react';

import { buildDispatchPreview } from '@/lib/dispatchPreview';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';

interface DispatchDialogProps {
  /** What the user selected — every one of these appears in the preview. */
  tasks: TaskDoc[];
  readyIds: ReadonlySet<string>;
  /** Agents already working, which is what eats into the concurrency budget. */
  runningNow: number;
  /** Starting concurrency, from the project's config. */
  defaultConcurrency: number;
  title: string;
  onConfirm: (concurrency: number) => Promise<void>;
  onCancel: () => void;
}

const DISPOSITION_LABEL = {
  'starts-now': 'starts now',
  queued: 'queued',
  'not-ready': 'cannot start',
} as const;

/**
 * Confirms a bulk dispatch by showing exactly what it will do.
 *
 * The reason this is a dialog rather than a button: concurrency is bounded, so dispatching
 * twelve tasks at a concurrency of eight does not start twelve agents. Every selected task is
 * listed and badged — starting now, queued, or un-startable — because the failure this exists to
 * prevent is silently dropping four of them and reporting success.
 *
 * The concurrency is editable here rather than fixed, since it is chosen per dispatch (see
 * handleWorkEpic); changing it updates the preview live, which is the fastest way to understand
 * what the number actually does.
 */
export function DispatchDialog({
  tasks,
  readyIds,
  runningNow,
  defaultConcurrency,
  title,
  onConfirm,
  onCancel,
}: DispatchDialogProps) {
  const [concurrency, setConcurrency] = useState(String(defaultConcurrency));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = useMemo(
    () =>
      buildDispatchPreview({
        tasks,
        readyIds,
        runningNow,
        concurrency: Number(concurrency) || 1,
      }),
    [tasks, readyIds, runningNow, concurrency]
  );

  return (
    <div
      className="bg-overlay fixed inset-0 z-50 grid place-items-center p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <div className="bg-card shadow-hairline-strong w-[min(560px,100%)] rounded-xl p-5">
        <h2 className="text-[17px] font-medium">{title}</h2>
        <p className="text-muted-foreground mt-1 text-[12.5px]">
          {preview.summary}
        </p>

        <label className="mt-3 flex items-center gap-2">
          <span className="text-muted-foreground text-[12px]">Run at most</span>
          <input
            value={concurrency}
            onChange={(e) => setConcurrency(e.target.value)}
            inputMode="numeric"
            aria-label="Concurrency"
            className="shadow-hairline w-14 rounded-md px-2 py-1 text-center font-mono text-[12.5px] outline-none"
          />
          <span className="text-muted-foreground text-[12px]">at a time</span>
        </label>

        <ul className="mt-3 max-h-64 overflow-y-auto">
          {preview.rows.map((row) => (
            <li
              key={row.taskId}
              className="grid grid-cols-[64px_minmax(0,1fr)_90px] items-center gap-2 py-1"
            >
              <span className="dense-meta">{row.taskId}</span>
              <span
                className={cn(
                  'truncate text-[13px]',
                  row.disposition === 'starts-now'
                    ? 'text-foreground'
                    : 'text-muted-foreground'
                )}
              >
                {row.title}
              </span>
              <span
                className={cn(
                  'dense-meta text-right',
                  row.disposition === 'starts-now' && 'text-accent-foreground',
                  row.disposition === 'not-ready' && 'text-state-blocked'
                )}
              >
                {DISPOSITION_LABEL[row.disposition]}
              </span>
            </li>
          ))}
        </ul>

        {error !== null && (
          <p className="text-state-failed mt-2 text-[12px]">{error}</p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy || preview.startsNow + preview.queued === 0}
            onClick={() => {
              setBusy(true);
              setError(null);
              void onConfirm(Number(concurrency) || 1)
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
            <Zap className="size-3.5" />
            Dispatch {preview.startsNow + preview.queued}
          </Button>
        </div>
      </div>
    </div>
  );
}
