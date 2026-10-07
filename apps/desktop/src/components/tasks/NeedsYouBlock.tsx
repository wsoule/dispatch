import type { Message } from '@dispatch/client';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { useThreadPaneProps } from '../../hooks/useThreadPaneProps';
import { useOpenGates, useThreadActions } from '../../hooks/useThreads';
import type { DecisionItem } from '../../lib/decisionFeed';
import { formatRelativeTimeFromIso } from '../../lib/format';
import { gateOf } from '../../lib/gates';
import {
  ASK_GROUP_LABEL,
  ASK_GROUP_ORDER,
  askGroup,
  type AskGroup,
  type NeedsYou,
} from '../../lib/needsYou';
import type { RefAction } from '../../lib/threadSources';
import { rowControl } from '../../lib/threadSources';
import {
  GateCard,
  type GateReply,
  RegistrationCard,
  WakeCard,
} from '../gates/GateCard';
import { cn } from '@/lib/utils';
import { GroupHeader } from '@/ui/ai/group-header';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { SectionLabel } from '@/ui/chrome';
import { CollapseBar } from '@/ui/chrome/collapse-bar';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/collapsible';

const MAX_ROWS = 8;

// The fixed-width marker leading every row: what sort of ask it is, tinted by state.
function KindBadge({
  tone = 'waiting',
  children,
}: {
  tone?: 'waiting' | 'done';
  children: ReactNode;
}) {
  return (
    <Badge
      variant="ghost"
      className={cn(
        'h-5 w-16 px-1.5 text-[11px] font-normal',
        tone === 'waiting'
          ? 'bg-(--state-waiting-surface) text-(--state-waiting-fg)'
          : 'bg-surface-quaternary'
      )}
    >
      {children}
    </Badge>
  );
}

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
      return item.reason === 'handoff' ? 'handoff' : 'question';
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

// What a receipt says a click did.
const VERB: Record<string, string> = {
  approve: 'Approved',
  allow: 'Allowed',
  'approve-session': 'Allowed for session',
  confirm: 'Approved',
  accept: 'Accepted',
  deny: 'Denied',
  reject: 'Rejected',
  decline: 'Declined',
  cancel: 'Cancelled',
};

function verbFor(reply: GateReply): string {
  if (reply.choice === undefined) return 'Answered';
  return VERB[reply.choice] ?? `Answered “${reply.choice}”`;
}

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      });
}

interface Receipt {
  item: DecisionItem;
  text: string;
}

export interface NeedsYouBlockProps {
  data: DispatchProjectData;
  needs: NeedsYou;
  /** Asks of mine decided elsewhere a moment ago; shown as receipts, never counted. */
  decided?: readonly DecisionItem[];
  onOpenRef: (action: RefAction) => void;
  /** Where an ask with no gate card (a capped fix loop, a stalled run) is handled. */
  onOpenDecision: (item: DecisionItem) => void;
  /** Drops the list's own margins, for a column that spaces its children. */
  flush?: boolean;
  /** Controls folding from outside, e.g. a view that keeps the block to one line. */
  folded?: boolean;
  onFoldedChange?: (folded: boolean) => void;
}

/** Every ask waiting on you, pinned above the list, regardless of filters. */
export function NeedsYouBlock({
  data,
  needs,
  decided = [],
  onOpenRef,
  onOpenDecision,
  flush = false,
  folded: foldedProp,
  onFoldedChange,
}: NeedsYouBlockProps) {
  const { client, port, me, messageAccess: access } = data;
  const gates = useOpenGates(client, port, access);
  const pane = useThreadPaneProps(data, onOpenRef);
  const actions = useThreadActions(client, port, me, access, data);
  const [foldedState, setFoldedState] = useState(false);
  const folded = foldedProp ?? foldedState;
  const setFolded = (next: boolean) => {
    if (foldedProp === undefined) setFoldedState(next);
    onFoldedChange?.(next);
  };
  // Asks answered here, kept in place as receipts so rows never reshuffle.
  const [answered, setAnswered] = useState<ReadonlyMap<string, Receipt>>(
    new Map()
  );
  const gateById = useMemo(
    () => new Map((gates.data?.items ?? []).map((m) => [m.id, m])),
    [gates.data]
  );
  const { answer } = actions;

  const decide = useCallback(
    async (item: DecisionItem, message: Message, reply: GateReply) => {
      await answer(message, reply);
      const text = `✓ ${verbFor(reply)} · ${item.summary} · ${clock(new Date().toISOString())} · your click, no agent turn`;
      setAnswered((prev) => new Map(prev).set(item.id, { item, text }));
    },
    [answer]
  );

  // Receipts per group: answered here, then decided elsewhere, never an open ask.
  const receiptsByGroup = useMemo(() => {
    const open = new Set(needs.asks.map((a) => a.id));
    const out = new Map<AskGroup, Receipt[]>();
    const add = (receipt: Receipt) => {
      const group = askGroup(receipt.item);
      if (group === null || open.has(receipt.item.id)) return;
      out.set(group, [...(out.get(group) ?? []), receipt]);
    };
    for (const receipt of answered.values()) add(receipt);
    for (const item of decided) {
      if (answered.has(item.id)) continue;
      const at =
        item.resolvedAt === undefined ? '' : ` · ${clock(item.resolvedAt)}`;
      add({ item, text: `Decided by you · ${item.summary}${at}` });
    }
    return out;
  }, [needs.asks, answered, decided]);

  const card = (item: DecisionItem, gate: Message): ReactNode => {
    if (me === null) return null;
    const gateData = gateOf(gate);
    const onDecide = (choice: 'approve' | 'deny') =>
      decide(item, gate, { body: '', choice });
    if (gateData?.type === 'wake') {
      return (
        <WakeCard
          target={gateData.target}
          onDecide={onDecide}
          canDecide={access.canDecide}
        />
      );
    }
    if (gateData?.type === 'agent-registration') {
      return (
        <RegistrationCard
          agent={gateData.agent}
          client={gateData.client}
          requestedBy={gateData.requestedBy}
          onDecide={onDecide}
          canDecide={access.canDecide}
        />
      );
    }
    return (
      <GateCard
        message={gate}
        control={rowControl(gate, { me, open: true, access })}
        lookups={pane.lookups}
        onOpen={pane.onOpen}
        availability={pane.availability}
        onRestartDaemon={pane.onRestartDaemon}
        answer={(reply) => decide(item, gate, reply)}
        loadApprovalInput={pane.loadApprovalInput}
        client={client}
        port={port}
      />
    );
  };

  const approveAll = (lessons: readonly DecisionItem[]) =>
    Promise.all(
      lessons.flatMap((lesson) => {
        const gate =
          lesson.messageId === undefined
            ? undefined
            : gateById.get(lesson.messageId);
        return gate === undefined
          ? []
          : [decide(lesson, gate, { body: '', choice: 'approve' })];
      })
    ).then(() => undefined);

  const groups = ASK_GROUP_ORDER.flatMap((group) => {
    const items = needs.groups.find((g) => g.group === group)?.items ?? [];
    const receipts = receiptsByGroup.get(group) ?? [];
    return items.length + receipts.length === 0
      ? []
      : [{ group, items, receipts }];
  });

  return (
    <section
      aria-label="Needs you"
      data-testid="needs-you"
      className={cn(
        'bg-background border-border rounded-card shadow-card border-[0.5px]',
        !flush && 'mx-4 mt-3 mb-1'
      )}
    >
      <Collapsible open={!folded} onOpenChange={(open) => setFolded(!open)}>
        <GroupHeader
          className={cn('relative', !folded && 'rounded-b-none')}
          tint={needs.count > 0 ? 'var(--state-waiting-fg)' : undefined}
          icon={
            <ChevronDown
              aria-hidden
              className={cn(
                'text-muted-foreground transition-transform duration-100',
                folded && '-rotate-90'
              )}
            />
          }
          name={
            // The trigger's hit area stretches over the whole bar.
            <CollapsibleTrigger className="after:rounded-card focus-visible:after:ring-ring block w-full truncate text-left outline-none after:absolute after:inset-0 focus-visible:after:ring-2">
              <span
                className="text-foreground font-semibold"
                data-testid="needs-you-count"
              >
                {needs.count === 0
                  ? 'Nothing needs you'
                  : `Needs you · ${needs.count}`}
              </span>
              {needs.count > 0 &&
                (folded ? (
                  <span
                    data-testid="needs-you-preview"
                    className="text-muted-foreground ml-2 text-[12px] font-normal"
                  >
                    {groups.find((g) => g.items.length > 0)?.items[0]?.summary}
                  </span>
                ) : (
                  <span className="text-muted-foreground ml-2 text-[12px] font-normal">
                    oldest first · this machine only
                  </span>
                ))}
            </CollapsibleTrigger>
          }
        />
        <CollapsibleContent>
          {groups.map(({ group, items, receipts }) => (
            <AskGroupSection
              key={group}
              group={group}
              items={items}
              receipts={receipts}
              restored={needs.restored}
              gateById={gateById}
              card={card}
              onApproveAll={approveAll}
              canDecide={access.canDecide}
              onOpenDecision={onOpenDecision}
              onOpenTask={(taskId) => onOpenRef({ kind: 'task', taskId })}
            />
          ))}
          {needs.teammates.length > 0 && (
            <TeammatesFooter items={needs.teammates} />
          )}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

function AskGroupSection({
  group,
  items,
  receipts,
  restored,
  gateById,
  card,
  onApproveAll,
  canDecide,
  onOpenDecision,
  onOpenTask,
}: {
  group: AskGroup;
  items: readonly DecisionItem[];
  receipts: readonly Receipt[];
  restored: readonly DecisionItem[];
  gateById: ReadonlyMap<string, Message>;
  card: (item: DecisionItem, gate: Message) => ReactNode;
  onApproveAll: (lessons: readonly DecisionItem[]) => Promise<void>;
  canDecide: boolean;
  onOpenDecision: (item: DecisionItem) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, MAX_ROWS);
  const hidden = items.length - shown.length;
  return (
    <div
      role="group"
      aria-label={ASK_GROUP_LABEL[group]}
      data-testid={`needs-you-group-${group}`}
    >
      <SectionLabel count={items.length} className="px-3 pt-2 pb-1">
        {ASK_GROUP_LABEL[group]}
      </SectionLabel>
      <ul>
        {shown.map((item) =>
          restored.length > 1 && item.id === restored[0]?.id ? (
            <RestoredBatchRow
              key={item.id}
              lessons={restored}
              gateById={gateById}
              card={card}
              onApproveAll={onApproveAll}
              canDecide={canDecide}
            />
          ) : (
            <AskRow
              key={item.id}
              item={item}
              gate={
                item.messageId === undefined
                  ? undefined
                  : gateById.get(item.messageId)
              }
              card={card}
              onOpenDecision={onOpenDecision}
              onOpenTask={onOpenTask}
            />
          )
        )}
        {receipts.map((receipt) => (
          <li
            key={`receipt:${receipt.item.id}`}
            data-testid="needs-you-receipt"
            className="border-border text-muted-foreground flex items-center gap-2.5 border-t-[0.5px] px-3 py-1.5 text-[12px]"
          >
            <KindBadge tone="done">{kindLabel(receipt.item)}</KindBadge>
            <span className="min-w-0 truncate">{receipt.text}</span>
          </li>
        ))}
      </ul>
      {items.length > MAX_ROWS && (
        <div className="px-3 pb-2">
          <CollapseBar
            label={all ? 'Show fewer' : `+${hidden} more`}
            collapsed={!all}
            onToggle={() => setAll(!all)}
          />
        </div>
      )}
    </div>
  );
}

function AskRow({
  item,
  gate,
  card,
  onOpenDecision,
  onOpenTask,
}: {
  item: DecisionItem;
  gate: Message | undefined;
  card: (item: DecisionItem, gate: Message) => ReactNode;
  onOpenDecision: (item: DecisionItem) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const { taskId } = item;
  return (
    <li
      data-testid="needs-you-row"
      title={gate === undefined ? undefined : 'this machine only'}
      // A new ask arrives from the left, where everything coming in flows from.
      className="border-border animate-in fade-in-0 slide-in-from-left-4 flex flex-col gap-2 border-t-[0.5px] px-3 py-2 duration-300 first:border-t-0 motion-reduce:animate-none"
    >
      <div className="flex min-w-0 items-center gap-2.5 text-[13px]">
        <KindBadge>{kindLabel(item)}</KindBadge>
        <span className="min-w-0 flex-1 truncate">{item.summary}</span>
        {taskId !== undefined && (
          <Button size="xs" variant="ghost" onClick={() => onOpenTask(taskId)}>
            › {taskId}
          </Button>
        )}
        <span className="text-muted-foreground w-14 shrink-0 text-right text-[12px]">
          {formatRelativeTimeFromIso(item.since)}
        </span>
      </div>
      <div className="pl-[74px]">
        {gate !== undefined ? (
          card(item, gate)
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenDecision(item)}
          >
            Open
          </Button>
        )}
      </div>
    </li>
  );
}

// Restored lessons: one row, approved together or reviewed one by one.
function RestoredBatchRow({
  lessons,
  gateById,
  card,
  onApproveAll,
  canDecide,
}: {
  lessons: readonly DecisionItem[];
  gateById: ReadonlyMap<string, Message>;
  card: (item: DecisionItem, gate: Message) => ReactNode;
  onApproveAll: (lessons: readonly DecisionItem[]) => Promise<void>;
  canDecide: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <li
      data-testid="needs-you-row"
      title="this machine only"
      className="border-border flex flex-col gap-2 border-t-[0.5px] px-3 py-2 first:border-t-0"
    >
      <div className="flex min-w-0 items-center gap-2.5 text-[13px]">
        <KindBadge>lessons</KindBadge>
        <span className="min-w-0 flex-1 truncate">
          Review {lessons.length} restored lessons
        </span>
        <Button
          size="sm"
          disabled={!canDecide || busy}
          onClick={() => {
            setBusy(true);
            void onApproveAll(lessons).finally(() => setBusy(false));
          }}
        >
          Approve all
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Review one by one'}
        </Button>
      </div>
      {open && (
        <ul className="flex flex-col gap-2 pl-[74px]">
          {lessons.map((lesson) => {
            const gate =
              lesson.messageId === undefined
                ? undefined
                : gateById.get(lesson.messageId);
            return gate === undefined ? null : (
              <li key={lesson.id}>{card(lesson, gate)}</li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

// Other people's asks on this daemon: visible, never counted, never answered here.
function TeammatesFooter({ items }: { items: readonly DecisionItem[] }) {
  const first = items[0];
  return (
    <Collapsible className="border-border border-t-[0.5px] px-1.5 py-1 text-[12px] text-(--text-ghost)">
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="group max-w-full text-(--text-ghost)"
          />
        }
      >
        <ChevronRight
          aria-hidden
          className="transition-transform duration-100 group-data-panel-open:rotate-90"
        />
        <span className="truncate">
          Teammates · {items.length} {items.length === 1 ? 'ask' : 'asks'}
          {first !== undefined && ` · ${first.summary}`} · not counted
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col gap-0.5 px-1.5 pt-0.5 pb-1">
          {items.map((item) => (
            <li key={item.id}>
              {item.owner ?? 'someone'}: {item.summary}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
