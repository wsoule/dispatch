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
}

/** Every ask waiting on you, pinned above the list, regardless of filters. */
export function NeedsYouBlock({
  data,
  needs,
  decided = [],
  onOpenRef,
  onOpenDecision,
  flush = false,
}: NeedsYouBlockProps) {
  const { client, port, me, messageAccess: access } = data;
  const gates = useOpenGates(client, port, access);
  const pane = useThreadPaneProps(data, onOpenRef);
  const actions = useThreadActions(client, port, me, access, data);
  const [folded, setFolded] = useState(false);
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
        groups.map(({ group, items, receipts }) => (
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
      {!folded && needs.teammates.length > 0 && (
        <TeammatesFooter items={needs.teammates} />
      )}
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
    <div data-testid={`needs-you-group-${group}`}>
      <h3 className="text-muted-foreground px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide uppercase">
        {ASK_GROUP_LABEL[group]} · {items.length}
      </h3>
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
            className="border-border text-muted-foreground border-t-[0.5px] px-3 py-1.5 text-[12px]"
          >
            {receipt.text}
          </li>
        ))}
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
        <span className="rounded-chip w-16 shrink-0 bg-(--state-waiting-surface) px-1.5 text-center text-[11px] text-(--state-waiting-fg)">
          lessons
        </span>
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
        <ul className="mt-1 flex flex-col gap-0.5">
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
