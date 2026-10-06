import type { Message } from '@dispatch/client';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { useThreadPaneProps } from '../../hooks/useThreadPaneProps';
import { useOpenGates, useThreadActions } from '../../hooks/useThreads';
import type { DecisionItem } from '../../lib/decisionFeed';
import { formatRelativeTimeFromIso } from '../../lib/format';
import {
  ASK_GROUP_LABEL,
  type AskGroupRows,
  type NeedsYou,
} from '../../lib/needsYou';
import type { RefAction } from '../../lib/threadSources';
import { rowControl } from '../../lib/threadSources';
import { GateCard } from '../gates/GateCard';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';

const MAX_ROWS = 8;

// The kind marker on a row: what sort of ask it is, in a word.
function kindLabel(item: DecisionItem): string {
  switch (item.kind) {
    case 'approval':
      switch (item.reason) {
        case 'tool-approval':
          return item.conversation === undefined ? 'tool' : 'overseer';
        case 'overseer-action':
          return 'overseer';
        case 'wake':
          return 'wake';
        case 'agent-registration':
          return 'agent';
        case 'task-proposal':
          return 'proposal';
        default:
          return 'approval';
      }
    case 'scope-request':
      return 'scope';
    case 'question':
      return 'question';
    case 'doc':
      return 'doc edit';
    case 'memory':
      return 'memory';
    case 'fix-loop-capped':
      return 'fix loop';
    case 'run-stalled':
      return 'stalled';
  }
}

export interface NeedsYouBlockProps {
  data: DispatchProjectData;
  needs: NeedsYou;
  onOpenRef: (action: RefAction) => void;
  /** Where an ask with no gate card (a capped fix loop, a stalled run) is handled. */
  onOpenDecision: (item: DecisionItem) => void;
}

/** Every ask waiting on you, pinned above the list, regardless of filters. */
export function NeedsYouBlock({
  data,
  needs,
  onOpenRef,
  onOpenDecision,
}: NeedsYouBlockProps) {
  const { client, port, me, messageAccess: access } = data;
  const gates = useOpenGates(client, port, access);
  const pane = useThreadPaneProps(data, onOpenRef);
  const actions = useThreadActions(client, port, me, access, data);
  const [folded, setFolded] = useState(false);
  const gateById = useMemo(
    () => new Map((gates.data?.items ?? []).map((m) => [m.id, m])),
    [gates.data]
  );

  return (
    <section
      aria-label="Needs you"
      data-testid="needs-you"
      className="bg-background border-border rounded-card shadow-card mx-4 mt-3 mb-1 border-[0.5px]"
    >
      <button
        type="button"
        onClick={() => setFolded(!folded)}
        aria-expanded={!folded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {folded ? (
          <ChevronRight
            aria-hidden
            className="text-muted-foreground size-3.5"
          />
        ) : (
          <ChevronDown aria-hidden className="text-muted-foreground size-3.5" />
        )}
        <span
          className="text-[13px] font-semibold"
          data-testid="needs-you-count"
        >
          {needs.count === 0
            ? 'Nothing needs you'
            : `Needs you · ${needs.count}`}
        </span>
        {needs.count > 0 && (
          <span className="text-muted-foreground text-[12px]">
            oldest first · this machine only
          </span>
        )}
      </button>
      {!folded &&
        needs.groups.map((group) => (
          <AskGroupSection
            key={group.group}
            group={group}
            me={me}
            gateById={gateById}
            render={(message) =>
              me === null ? null : (
                <GateCard
                  message={message}
                  control={rowControl(message, { me, open: true, access })}
                  lookups={pane.lookups}
                  onOpen={pane.onOpen}
                  availability={pane.availability}
                  onRestartDaemon={pane.onRestartDaemon}
                  answer={(reply) => actions.answer(message, reply)}
                  loadApprovalInput={pane.loadApprovalInput}
                  client={client}
                  port={port}
                />
              )
            }
            onOpenDecision={onOpenDecision}
            onOpenTask={(taskId) => onOpenRef({ kind: 'task', taskId })}
          />
        ))}
      {!folded && needs.teammates.length > 0 && (
        <TeammatesFooter items={needs.teammates} />
      )}
    </section>
  );
}

function AskGroupSection({
  group,
  me,
  gateById,
  render,
  onOpenDecision,
  onOpenTask,
}: {
  group: AskGroupRows;
  me: string | null;
  gateById: ReadonlyMap<string, Message>;
  render: (message: Message) => ReactNode;
  onOpenDecision: (item: DecisionItem) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? group.items : group.items.slice(0, MAX_ROWS);
  const hidden = group.items.length - shown.length;
  return (
    <div data-testid={`needs-you-group-${group.group}`}>
      <h3 className="text-muted-foreground px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide uppercase">
        {ASK_GROUP_LABEL[group.group]} · {group.items.length}
      </h3>
      <ul>
        {shown.map((item) => {
          const { taskId } = item;
          const gate =
            item.messageId === undefined
              ? undefined
              : gateById.get(item.messageId);
          return (
            <li
              key={item.id}
              data-testid="needs-you-row"
              title={gate === undefined ? undefined : 'this machine only'}
              className="border-border flex flex-col gap-2 border-t-[0.5px] px-3 py-2 first:border-t-0"
            >
              <div className="flex min-w-0 items-center gap-2.5 text-[13px]">
                <span className="rounded-chip w-16 shrink-0 bg-(--state-waiting-surface) px-1.5 text-center text-[11px] text-(--state-waiting-fg)">
                  {kindLabel(item)}
                </span>
                <span className="min-w-0 flex-1 truncate">{item.summary}</span>
                {taskId !== undefined && (
                  <button
                    type="button"
                    onClick={() => onOpenTask(taskId)}
                    className="text-muted-foreground shrink-0 text-[12px] hover:underline"
                  >
                    › {taskId}
                  </button>
                )}
                <span className="text-muted-foreground w-14 shrink-0 text-right text-[12px]">
                  {formatRelativeTimeFromIso(item.since)}
                </span>
              </div>
              {gate !== undefined && me !== null ? (
                <div className="pl-[74px]">{render(gate)}</div>
              ) : (
                <div className="pl-[74px]">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onOpenDecision(item)}
                  >
                    Open
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="text-muted-foreground px-3 pb-2 text-[12px] hover:underline"
        >
          +{hidden} more
        </button>
      )}
    </div>
  );
}

// Other people's asks on this daemon: visible, never counted, never answered here.
function TeammatesFooter({ items }: { items: readonly DecisionItem[] }) {
  const [open, setOpen] = useState(false);
  const first = items[0];
  return (
    <div className="border-border border-t-[0.5px] px-3 py-2 text-[12px] text-(--text-ghost)">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="hover:underline"
      >
        Teammates · {items.length} {items.length === 1 ? 'ask' : 'asks'}
        {first !== undefined && ` · ${first.summary}`} · not counted{' '}
        {open ? '▾' : '▸'}
      </button>
      {open && (
        <ul className={cn('mt-1 flex flex-col gap-0.5')}>
          {items.map((item) => (
            <li key={item.id}>
              {item.owner ?? 'someone'}: {item.summary}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
