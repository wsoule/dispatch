import { useQuery } from '@tanstack/react-query';
import { AlertCircle, FileX, Info } from 'lucide-react';

import { getFileDiffForSessionFile } from '../lib/tauri';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Skeleton } from '@/ui/skeleton';

interface DiffModalProps {
  sessionId: string;
  /** Human-readable session identity for the meta line, e.g. "claude-opus-4-8 · a1b2c3d4". */
  sessionLabel: string;
  /** The file to show, or `null` when no diff is being viewed (modal closed). */
  filePath: string | null;
  onClose: () => void;
}

const TAG_PREFIX: Record<string, string> = {
  insert: '+',
  delete: '-',
  equal: ' ',
};

const TAG_LINE_CLASS: Record<string, string> = {
  insert: 'bg-emerald-500/10',
  delete: 'bg-red-500/10',
  equal: '',
};

const TAG_PREFIX_CLASS: Record<string, string> = {
  insert: 'text-emerald-500',
  delete: 'text-red-500',
  equal: 'text-muted-foreground/40',
};

/**
 * Shows one cumulative before/after diff for everything this session did to `filePath` —
 * before-text from its earliest edit, after-text from its most recent — rather than one diff
 * per tool call, computed by the backend from the raw old/new text captured at ingest time.
 * Distinct from `openInEditor` (`SessionDetailModal`'s "Open" button) — that opens the file's
 * *current* on-disk state, which may have changed since; this shows exactly what this
 * session's edits did.
 *
 * Renders its own `Dialog` (rather than being plain content inside `SessionDetailModal`'s
 * dialog) so it keeps stacking as an independent overlay on top of the session detail dialog,
 * matching the original two-modals-deep behavior.
 */
export function DiffModal({
  sessionId,
  sessionLabel,
  filePath,
  onClose,
}: DiffModalProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['file-diff', sessionId, filePath],
    queryFn: () => getFileDiffForSessionFile(sessionId, filePath),
    enabled: filePath !== null,
  });

  return (
    <Dialog
      open={filePath !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle
            className="truncate font-mono text-[13px] font-medium"
            title={filePath ?? undefined}
          >
            {filePath}
          </DialogTitle>
        </DialogHeader>

        {isLoading && (
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}
        {isError && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertCircle className="text-destructive size-5" />
            <p className="text-muted-foreground text-[13px]">
              Couldn&rsquo;t load this diff.
            </p>
          </div>
        )}
        {!isLoading && !isError && data === null && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <FileX className="text-muted-foreground size-5" />
            <p className="text-muted-foreground text-[13px]">
              This file change no longer exists.
            </p>
          </div>
        )}
        {!isLoading && !isError && data && (
          <>
            <p className="text-muted-foreground font-mono text-[11px]">
              {sessionLabel} · {data.edit_count} edit
              {data.edit_count === 1 ? '' : 's'} ·{' '}
              {new Date(data.occurred_at * 1000).toLocaleString()}
            </p>

            {data.lines.length === 0 ? (
              <p className="text-muted-foreground text-[13px]">
                No diff content captured for this change — it was recorded
                before Relay started storing before/after text.
              </p>
            ) : (
              <div className="-mx-6 flex flex-col">
                <div className="font-mono text-[13px] leading-relaxed">
                  {data.lines.map((line, i) => (
                    <div key={i} className={`flex ${TAG_LINE_CLASS[line.tag]}`}>
                      <span
                        className={`w-6 flex-shrink-0 text-center select-none ${TAG_PREFIX_CLASS[line.tag]}`}
                      >
                        {TAG_PREFIX[line.tag]}
                      </span>
                      <span className="min-w-0 flex-1 px-6 break-words whitespace-pre-wrap">
                        {line.content}
                      </span>
                    </div>
                  ))}
                </div>
                {data.truncated && (
                  <p className="text-muted-foreground mx-6 mt-2 flex items-center gap-1.5 text-[13px]">
                    <Info className="size-3.5" />
                    Diff truncated — this change is too large to show in full.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
