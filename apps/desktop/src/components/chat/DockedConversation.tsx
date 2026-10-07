import { type ApiClient, ApiError } from '@dispatch/client';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare, X } from 'lucide-react';
import { useEffect } from 'react';

import { overseerKey } from '../../hooks/useOverseerSession';
import { cn } from '@/lib/utils';
import { IconButton } from '@/ui/ai/icon-button';
import { ListRow } from '@/ui/ai/list-row';
import { PillButton } from '@/ui/ai/pill';
import { Spinner } from '@/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

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
  const glyph = waiting ? (
    <span aria-hidden className="bg-state-waiting size-1.5 rounded-full" />
  ) : record.state === 'running' ? (
    <Spinner className="size-3" />
  ) : record.state === 'failed' ? (
    <X aria-hidden className="text-state-failed" />
  ) : (
    <MessageSquare aria-hidden />
  );
  const status = waiting
    ? 'waiting on you'
    : record.state === 'running'
      ? 'working'
      : record.state === 'failed'
        ? 'failed'
        : undefined;
  const reply = record.messages.findLast((m) => m.role === 'assistant')?.text;
  const close = (
    <IconButton
      label="Close this set-aside conversation"
      onClick={onClose}
      className={cn(
        !compact &&
          'opacity-0 group-hover/docked:opacity-100 focus-visible:opacity-100'
      )}
    >
      <X />
    </IconButton>
  );
  const trigger = compact ? (
    <PillButton
      data-testid="overseer-docked"
      onClick={onRestore}
      className="max-w-64"
    >
      {glyph}
      <span className="min-w-0 truncate">{record.prompt}</span>
      {status !== undefined && (
        <span className="text-muted-foreground font-book">{status}</span>
      )}
    </PillButton>
  ) : (
    <ListRow
      role="listitem"
      data-testid="overseer-docked"
      onClick={onRestore}
      leading={glyph}
      title={record.prompt}
      date={status}
    />
  );

  // The close button sits beside the row, never inside it: no button within a button.
  return (
    <div className="group/docked flex min-w-0 items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger
          render={<div className={cn('min-w-0', !compact && 'flex-1')} />}
        >
          {trigger}
        </TooltipTrigger>
        <TooltipContent
          side={compact ? 'top' : 'left'}
          className="flex max-w-72 flex-col gap-0.5 text-pretty"
        >
          <span className="font-medium">{record.prompt}</span>
          <span className="line-clamp-3 opacity-80">
            {reply ?? 'Bring this conversation back'}
          </span>
        </TooltipContent>
      </Tooltip>
      {close}
    </div>
  );
}
