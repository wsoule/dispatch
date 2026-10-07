import type { MergeQueueEntry, RunMeta } from '@dispatch/client';
import { Minus, PowerOff } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { DockedConversation } from '../components/chat/DockedConversation';
import { OverseerChat } from '../components/chat/OverseerChat';
import {
  InflowColumn,
  OutflowColumn,
} from '../components/overseer/FlowColumns';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { OverseerSession } from '../hooks/useOverseerSession';
import { docked, restored, useOverseerDock } from '../lib/overseerDock';
import type { OverseerDoor } from '../lib/overseerThread';
import { cn } from '@/lib/utils';
import { NoticePill } from '@/ui/ai/notice-pill';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

export interface TwoViewOverseerProps {
  data: DispatchProjectData;
  overseer: OverseerSession;
  /** The project, which keys its own set-aside conversations. */
  projectPath: string | null;
  /** Asks waiting on you; the stream shows a door to them, never a copy. */
  asks: number;
  /** The Needs you block, beside the stream on a wide window. */
  needsBlock?: ReactNode;
  /** What a side column opened, shown in the middle in place of the conversation. */
  focus?: OverseerFocus | null;
  onFocus?: (focus: OverseerFocus | null) => void;
  renderFocus?: (focus: OverseerFocus, onClose: () => void) => ReactNode;
  revoked: boolean;
  onShowAsks: () => void;
  onOpenConnectedAgents: () => void;
  /** "For you" posts: beside the stream on a wide window, above the composer otherwise. */
  posts?: ReactNode;
  /** How many posts `posts` holds, for the Coming in count. */
  postsCount?: number;
  /** Live and recent runs, and the merge queue's entries, for the Going out column. */
  runs?: readonly RunMeta[];
  merges?: readonly MergeQueueEntry[];

  /** Opens one of the agent's "Show in tasks" doors. */
  onOpenDoor: (door: OverseerDoor) => void;
}

const isSlash = (text: string) => text.trimStart().startsWith('/');

/** What a side column can open in the middle: a task (maybe on its conversation) or someone's talk. */
export type OverseerFocus =
  | { kind: 'task'; taskId: string; conversation?: boolean }
  | { kind: 'address'; address: string };

/**
 * Overseer in Two views: the open conversation in the middle; on a wide window
 * the asks and any set-aside conversations sit in a column on the right.
 */
export function TwoViewOverseer({
  data,
  overseer,
  projectPath,
  asks,
  needsBlock,
  revoked,
  onShowAsks,
  onOpenConnectedAgents,
  posts,
  postsCount = 0,
  runs = [],
  merges = [],
  focus = null,
  onFocus = () => {},
  renderFocus,
  onOpenDoor,
}: TwoViewOverseerProps) {
  // Whatever a side column opened takes the middle; Esc hands it back to the talk.
  useEffect(() => {
    if (focus === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onFocus(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus, onFocus]);
  const focused =
    focus !== null && renderFocus !== undefined
      ? renderFocus(focus, () => onFocus(null))
      : null;
  const { dock: stored, setDock } = useOverseerDock(projectPath);
  const open = overseer.conversationId;
  const dock = useMemo(
    () => stored.filter((id) => id !== open),
    [stored, open]
  );
  // The conversation Jev just set aside for a new topic, for "Put it back".
  const [setAside, setSetAside] = useState<{
    id: string;
    title: string;
  } | null>(null);

  const minimize = () => {
    if (open === null) return;
    setDock((d) => docked(d, open));
    setSetAside(null);
    overseer.reset();
  };
  const restore = (id: string) => {
    setDock((d) => restored(d, id, open));
    setSetAside(null);
    overseer.open(id);
  };
  const close = (id: string) => setDock((d) => d.filter((x) => x !== id));

  // A message Jev reads as a new subject opens its own conversation and sets
  // the current one aside; anything else, or no reading, stays put.
  const client = data.client;
  const routed: OverseerSession = {
    ...overseer,
    submit: async (text) => {
      if (open !== null && client !== null && !isSlash(text)) {
        const reading = await client
          .judgeOverseerTopic(open, text)
          .catch(() => null);
        if (reading?.newTopic === true) {
          setDock((d) => docked(d, open));
          setSetAside({ id: open, title: overseer.record?.prompt ?? open });
          await overseer.submitNew(text);
          return;
        }
      }
      await overseer.submit(text);
    },
  };

  if (data.portLoading || data.portError || client === null) {
    return (
      <div className="px-6 py-4">
        <DaemonUnavailable
          starting={data.portLoading}
          errorDetail={data.portErrorDetail}
          onRetry={data.retryEnsureDispatchd}
        />
      </div>
    );
  }

  const showAsksAside = asks > 0 && needsBlock !== undefined && !revoked;
  const door =
    revoked || asks === 0 ? null : (
      <NoticePill
        tone="waiting"
        onClick={onShowAsks}
        data-testid="overseer-asks-door"
        // On a wide window the asks themselves are beside the stream.
        className={cn('self-center', showAsksAside && 'xl:hidden')}
      >
        ● {asks} {asks === 1 ? 'ask waits' : 'asks wait'} on you · Show in tasks
        →
      </NoticePill>
    );
  const dockCards = (compact: boolean) =>
    dock.map((id) => (
      <DockedConversation
        key={id}
        client={client}
        port={data.port}
        conversationId={id}
        compact={compact}
        onRestore={() => restore(id)}
        onClose={() => close(id)}
      />
    ));

  return (
    <div
      data-testid="overseer-view"
      className="flex h-full min-h-0 gap-6 px-6 pt-3 pb-4"
    >
      {/* Wide windows read left to right: what comes to you, the talk, what leaves. */}
      <InflowColumn count={(showAsksAside ? asks : 0) + postsCount}>
        {showAsksAside && needsBlock}
        {posts}
      </InflowColumn>
      {/* Before the first message the composer sits at the bottom, as it will after. */}
      {focused !== null && (
        <div
          data-testid="overseer-focus"
          className="rounded-card border-border bg-background flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-[0.5px]"
        >
          {focused}
        </div>
      )}
      {/* Hidden, not unmounted, while something else holds the middle: the draft survives. */}
      <div
        className={cn(
          'mx-auto flex h-full min-h-0 w-full max-w-[760px] min-w-0 flex-col gap-3',
          open === null && 'justify-end',
          focused !== null && 'hidden'
        )}
      >
        {open !== null && (
          <div className="flex justify-end">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={minimize}
                    data-testid="overseer-minimize"
                  />
                }
              >
                <Minus /> Set aside
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Set this conversation aside and start another
              </TooltipContent>
            </Tooltip>
          </div>
        )}
        {setAside !== null && (
          <div
            role="status"
            className="text-muted-foreground font-book flex items-center gap-2 text-[12px]"
          >
            <span className="min-w-0 flex-1 truncate">
              New topic, so a new conversation · “{setAside.title}” is set aside
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => restore(setAside.id)}
            >
              Put it back
            </Button>
          </div>
        )}
        {revoked && (
          <Alert
            data-testid="overseer-off"
            className="rounded-card border-border border-[0.5px] border-dashed px-3 py-2"
          >
            <PowerOff className="text-muted-foreground size-3.5!" />
            <AlertTitle className="text-[13px]">The agent is off.</AlertTitle>
            <AlertDescription className="font-book text-[12px]">
              <Button
                size="xs"
                variant="outline"
                onClick={onOpenConnectedAgents}
              >
                Approve it again in Settings › Connected agents
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <OverseerChat
          overseer={routed}
          placeholder="say something"
          aboveComposer={
            <>
              <div className="xl:hidden">{posts}</div>
              {dock.length > 0 && (
                <div className="flex flex-wrap gap-1.5 xl:hidden">
                  {dockCards(true)}
                </div>
              )}
              {door}
            </>
          }
          disabled={revoked}
          durable
          onOpenDoor={onOpenDoor}
        />
      </div>
      <OutflowColumn
        runs={runs}
        merges={merges}
        setAside={dockCards(false)}
        onOpenTask={(taskId) => onFocus({ kind: 'task', taskId })}
      />
    </div>
  );
}
