import type { Message } from '@dispatch/client';
import {
  Button,
  Chip,
  cx,
  Disclosure,
  Register,
  RegisterCell,
  RegisterRow,
  SectionHeader,
} from '@dispatch/ui';
import { ChevronDown } from 'lucide-react';
import { type ReactNode, useCallback, useId, useMemo, useState } from 'react';

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
import {
  answersWithText,
  participantLabel,
  rowControl,
} from '../../lib/threadSources';
import {
  GateCard,
  type GateReply,
  RegistrationCard,
  WakeCard,
} from '../gates/GateCard';
import { QuestionAnswerForm } from '../gates/QuestionAnswerForm';
import styles from './NeedsYouBlock.module.css';

const MAX_ROWS = 8;

/* The rows' grid: the kind chip, the summary (it takes the room), the
   task button and the relative time. Every row is its own grid, so the
   chip and time tracks are fixed widths: the summaries line up down the
   list. Stacked (a narrow column), the chip leads, the summary wraps on
   its own line and the task and time share the next one. */
const ROW_COLUMNS = '80px minmax(0, 1fr) auto 56px';
const STACKED_COLUMNS = 'minmax(0, 1fr) auto';

// The marker leading every row: what sort of ask it is, as a chip. Amber
// (the pill's dot) while it waits on you, quiet text once decided; the word
// says the kind, so the colour is never the only cue.
function KindBadge({
  tone = 'waiting',
  children,
}: {
  tone?: 'waiting' | 'done';
  children: ReactNode;
}) {
  return (
    <Chip tone={tone === 'waiting' ? 'warning' : 'muted'}>{children}</Chip>
  );
}

// The hover hint over a row whose ask is answered here: gates live on this
// daemon only. The header says it in words too ("this machine only").
const MACHINE_ONLY = 'this machine only';

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
      // Merged, but only on this machine: not stalled work, an unfinished landing.
      return item.reason === 'not-on-origin' ? 'not pushed' : 'stalled';
  }
}

// What a receipt says a click did.
const VERB: Record<string, string> = {
  approve: 'Approved',
  allow: 'Allowed',
  'approve-session': 'Allowed for session',
  confirm: 'Approved',
  accept: 'Accepted',
  grant: 'Granted',
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
  const {
    client,
    port,
    me,
    messageAccess: access,
    handleDismissDecision,
  } = data;
  const gates = useOpenGates(client, port, access);
  const pane = useThreadPaneProps(data, onOpenRef);
  const actions = useThreadActions(client, port, me, access, data);
  const bodyId = useId();
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
    // A free-text question has no card to draw, so the row answers it here.
    if (answersWithText(gate, me)) {
      return access.canMessage ? (
        <QuestionAnswerForm
          asker={participantLabel(gate.from, pane.lookups)}
          onAnswer={(body) => decide(item, gate, { body })}
        />
      ) : null;
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

  const first = groups.find((g) => g.items.length > 0)?.items[0];
  // With no group and no teammates there is nothing under the header, so
  // the body (and its padding) stays out of the box.
  const empty = groups.length === 0 && needs.teammates.length === 0;
  return (
    <section
      aria-label="Needs you"
      data-testid="needs-you"
      className={cx(styles.block, flush ? undefined : styles.spaced)}
    >
      <SectionHeader
        as="h2"
        className={styles.header}
        tone={needs.count > 0 ? 'warning' : undefined}
        collapsed={folded}
        name={
          // The fold button's hit area stretches over the whole header row;
          // its name is the count and the line beside it.
          <button
            type="button"
            className={styles.fold}
            aria-expanded={!folded}
            aria-controls={bodyId}
            onClick={() => setFolded(!folded)}
          >
            <ChevronDown
              className={styles.chevron}
              size={14}
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <span className={styles.count} data-testid="needs-you-count">
              {needs.count === 0
                ? 'Nothing needs you'
                : `Needs you · ${needs.count}`}
            </span>
            {needs.count > 0 &&
              (folded ? (
                <span className={styles.aside} data-testid="needs-you-preview">
                  {first?.summary}
                </span>
              ) : (
                <span className={styles.aside}>
                  oldest first · this machine only
                </span>
              ))}
          </button>
        }
      />
      <div id={bodyId} className={styles.body} hidden={folded || empty}>
        {folded || empty ? null : (
          <>
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
                onDismiss={(id) => handleDismissDecision(id)}
                onOpenTask={(taskId) => onOpenRef({ kind: 'task', taskId })}
              />
            ))}
            {needs.dismissed.length > 0 && (
              <DismissedFooter
                items={needs.dismissed}
                onUndo={(id) => handleDismissDecision(id, true)}
              />
            )}
            {needs.teammates.length > 0 && (
              <TeammatesFooter items={needs.teammates} />
            )}
          </>
        )}
      </div>
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
  onDismiss,
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
  onDismiss: (id: string) => Promise<void>;
  onOpenTask: (taskId: string) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, MAX_ROWS);
  const hidden = items.length - shown.length;
  const label = ASK_GROUP_LABEL[group];
  return (
    <div
      role="group"
      aria-label={label}
      data-testid={`needs-you-group-${group}`}
      className={styles.group}
    >
      <SectionHeader as="h3" name={label} count={items.length} />
      <Register
        data-slot="needs-you-register"
        label={label}
        columns={ROW_COLUMNS}
        stackWithin={480}
        stackedColumns={STACKED_COLUMNS}
      >
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
              onDismiss={onDismiss}
              onOpenTask={onOpenTask}
            />
          )
        )}
        {receipts.map((receipt) => (
          <RegisterRow
            key={`receipt:${receipt.item.id}`}
            tone="muted"
            data-testid="needs-you-receipt"
            data-row="receipt"
          >
            <RegisterCell>
              <KindBadge tone="done">{kindLabel(receipt.item)}</KindBadge>
            </RegisterCell>
            <RegisterCell data-cell="receipt">
              <span className={styles.receipt} title={receipt.text}>
                {receipt.text}
              </span>
            </RegisterCell>
          </RegisterRow>
        ))}
      </Register>
      {items.length > MAX_ROWS && (
        <div className={styles.more}>
          <Button
            size="sm"
            variant="quiet"
            aria-expanded={all}
            onClick={() => setAll(!all)}
          >
            {all ? 'Show fewer' : `+${hidden} more`}
          </Button>
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
  onDismiss,
  onOpenTask,
}: {
  item: DecisionItem;
  gate: Message | undefined;
  card: (item: DecisionItem, gate: Message) => ReactNode;
  onOpenDecision: (item: DecisionItem) => void;
  onDismiss: (id: string) => Promise<void>;
  onOpenTask: (taskId: string) => void;
}) {
  const { taskId } = item;
  const [dismissing, setDismissing] = useState(false);
  return (
    // A new ask arrives from the left, where everything coming in flows
    // from (the module's slide-in, only when motion is welcome).
    <RegisterRow
      data-testid="needs-you-row"
      data-row="ask"
      title={gate === undefined ? undefined : MACHINE_ONLY}
    >
      <RegisterCell>
        <KindBadge>{kindLabel(item)}</KindBadge>
      </RegisterCell>
      <RegisterCell data-cell="summary">
        <span className={styles.summary} title={item.summary}>
          {item.summary}
        </span>
      </RegisterCell>
      <RegisterCell>
        {taskId !== undefined && (
          <Button size="sm" variant="quiet" onClick={() => onOpenTask(taskId)}>
            › <span className="mono">{taskId}</span>
          </Button>
        )}
      </RegisterCell>
      <RegisterCell variant="mono" align="end">
        {formatRelativeTimeFromIso(item.since)}
      </RegisterCell>
      <RegisterCell span="row" data-cell="answer">
        {gate !== undefined ? (
          card(item, gate)
        ) : (
          <span className={styles.actions}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onOpenDecision(item)}
            >
              Open
            </Button>
            {/* Only derived items carry a fingerprint; gates and floor holds
                are answered, never dismissed. */}
            {item.fingerprint !== undefined && (
              <Button
                size="sm"
                variant="quiet"
                data-testid="needs-you-dismiss"
                title="Hide until this changes"
                disabled={dismissing}
                onClick={() => {
                  setDismissing(true);
                  void onDismiss(item.id).finally(() => setDismissing(false));
                }}
              >
                Dismiss
              </Button>
            )}
          </span>
        )}
      </RegisterCell>
    </RegisterRow>
  );
}

// Asks I dismissed: hidden until their condition changes, listed here so each can be undone.
function DismissedFooter({
  items,
  onUndo,
}: {
  items: readonly DecisionItem[];
  onUndo: (id: string) => Promise<void>;
}) {
  return (
    <div className={styles.teammates} data-testid="needs-you-dismissed">
      <Disclosure
        summary={<>Dismissed · {items.length} · hidden until they change</>}
      >
        <ul className={styles.teammateList}>
          {items.map((item) => (
            <li key={item.id}>
              {item.summary}{' '}
              <Button
                variant="quiet"
                size="sm"
                onClick={() => void onUndo(item.id)}
              >
                Undo
              </Button>
            </li>
          ))}
        </ul>
      </Disclosure>
    </div>
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
    <RegisterRow
      data-testid="needs-you-row"
      data-row="ask"
      title={MACHINE_ONLY}
    >
      <RegisterCell>
        <KindBadge>lessons</KindBadge>
      </RegisterCell>
      <RegisterCell data-cell="summary">
        <span className={styles.summary}>
          Review {lessons.length} restored lessons
        </span>
      </RegisterCell>
      <RegisterCell data-cell="actions">
        <span className={styles.actions}>
          <Button
            size="sm"
            variant="primary"
            disabled={!canDecide || busy}
            onClick={() => {
              setBusy(true);
              void onApproveAll(lessons).finally(() => setBusy(false));
            }}
          >
            Approve all
          </Button>
          <Button
            size="sm"
            variant="quiet"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Hide' : 'Review one by one'}
          </Button>
        </span>
      </RegisterCell>
      {open && (
        <RegisterCell span="row" data-cell="answer">
          <ul className={styles.lessons}>
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
        </RegisterCell>
      )}
    </RegisterRow>
  );
}

// Other people's asks on this daemon: visible, never counted, never answered here.
function TeammatesFooter({ items }: { items: readonly DecisionItem[] }) {
  const first = items[0];
  return (
    <div className={styles.teammates}>
      <Disclosure
        summary={
          <>
            Teammates · {items.length} {items.length === 1 ? 'ask' : 'asks'}
            {first !== undefined && ` · ${first.summary}`} · not counted
          </>
        }
      >
        <ul className={styles.teammateList}>
          {items.map((item) => (
            <li key={item.id}>
              {item.owner ?? 'someone'}: {item.summary}
            </li>
          ))}
        </ul>
      </Disclosure>
    </div>
  );
}
