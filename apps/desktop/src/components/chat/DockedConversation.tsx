import { type ApiClient, ApiError } from '@dispatch/client';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect } from 'react';

import { overseerKey } from '../../hooks/useOverseerSession';
import { cn } from '@/lib/utils';
import { Spinner } from '@/ui/spinner';

/** One set-aside Overseer conversation: what it is, where it stands, and a way back. */
export function DockedConversation({
  client,
  port,
  conversationId,
  compact = false,
  onRestore,
  onClose,
}: {
  client: Pick<ApiClient, 'getOverseer'>;
  port: number | undefined;
  conversationId: string;
  /** A one-line chip, for windows too narrow for the side column. */
  compact?: boolean;
  onRestore: () => void;
  onClose: () => void;
}) {
  const { data: record, error } = useQuery({
    queryKey: overseerKey(port, conversationId),
    queryFn: () => client.getOverseer(conversationId),
    retry: false,
  });
  // A conversation the daemon no longer has leaves the dock.
  const gone = error instanceof ApiError && error.status === 404;
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  if (record === undefined) return null;

  const waiting =
    record.pendingApprovals.length > 0 || record.pendingActions.length > 0;
  const status = waiting ? (
    <span className="text-(--state-waiting-fg)">● waiting on you</span>
  ) : record.state === 'running' ? (
    <span className="inline-flex items-center gap-1">
      <Spinner className="size-3" /> working
    </span>
  ) : record.state === 'failed' ? (
    <span className="text-(--state-failed-fg)">✕ failed</span>
  ) : (
    (record.messages.findLast((m) => m.role === 'assistant')?.text ?? '')
  );

  return (
    <div
      data-testid="overseer-docked"
      className={cn(
        'rounded-card border-border group relative flex min-w-0 border-[0.5px]',
        compact ? 'items-center gap-2 px-2.5 py-1' : 'flex-col gap-1 px-3 py-2'
      )}
    >
      <button
        type="button"
        onClick={onRestore}
        title="Bring this conversation back"
        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
      >
        <span className="truncate text-[13px] font-medium">
          {record.prompt}
        </span>
        {!compact && (
          <span className="text-muted-foreground font-book line-clamp-2 text-[12px]">
            {status}
          </span>
        )}
      </button>
      {compact && (
        <span className="text-muted-foreground font-book shrink-0 text-[11px]">
          {status}
        </span>
      )}
      <button
        type="button"
        aria-label="Close this set-aside conversation"
        onClick={onClose}
        className="text-muted-foreground hover:text-foreground absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 focus:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
