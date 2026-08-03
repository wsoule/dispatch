import type { GitStatus } from '@dispatch/client';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Download,
  GitBranch,
  Upload,
} from 'lucide-react';

import { Button } from '@/ui/button';

interface StatusPanelProps {
  status: GitStatus | undefined;
  loading: boolean;
  busy: boolean;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onResolveConflicts: () => void;
}

/** Panel 1: current branch, upstream, ahead/behind, remote actions (fetch/pull/push), and a
 * conflict callout with a one-click path to an agent instead of a bare warning. */
export function StatusPanel({
  status,
  loading,
  busy,
  onFetch,
  onPull,
  onPush,
  onResolveConflicts,
}: StatusPanelProps) {
  if (loading || status === undefined) {
    return (
      <div className="text-muted-foreground p-3 text-[12px]">Loading…</div>
    );
  }

  const hasConflicts = status.conflicted.length > 0;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <GitBranch className="text-muted-foreground size-4 shrink-0" />
        <span className="truncate font-mono text-[13px]">
          {status.branch ?? 'detached HEAD'}
        </span>
      </div>
      {status.upstream !== null && (
        <div className="text-muted-foreground flex items-center gap-3 text-[11px]">
          <span className="truncate font-mono">{status.upstream}</span>
          <span className="flex items-center gap-1">
            <ArrowUp className="size-3" />
            {status.ahead}
          </span>
          <span className="flex items-center gap-1">
            <ArrowDown className="size-3" />
            {status.behind}
          </span>
        </div>
      )}

      {hasConflicts && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive flex flex-col gap-2 rounded-md border px-2.5 py-2 text-[12px]">
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="size-3.5 shrink-0" />
            {status.conflicted.length} conflicted file
            {status.conflicted.length === 1 ? '' : 's'}
          </span>
          <Button
            variant="outline"
            size="xs"
            className="self-start"
            onClick={onResolveConflicts}
          >
            Ask an agent to resolve
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="outline"
          size="xs"
          disabled={busy}
          onClick={onFetch}
          title="Fetch (f)"
        >
          <Download className="size-3" />
          Fetch
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={busy}
          onClick={onPull}
          title="Pull (p)"
        >
          <ArrowDown className="size-3" />
          Pull
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={busy}
          onClick={onPush}
          title="Push (P)"
        >
          <Upload className="size-3" />
          Push
        </Button>
      </div>
    </div>
  );
}
