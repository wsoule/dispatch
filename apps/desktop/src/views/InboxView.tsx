import type { ApiClient, RepoPr } from '@dispatch/client';
import { useQuery } from '@tanstack/react-query';
import {
  AtSign,
  Check,
  CheckCheck,
  CircleAlert,
  GitMerge,
  GitPullRequest,
  Hand,
  MoreHorizontal,
} from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { MemoryActivityList } from '../components/memory/MemoryActivityList';
import { ApprovalCard } from '../components/runs/ApprovalCard';
import { QuestionCard } from '../components/runs/QuestionCard';
import { ScopeRequestCard } from '../components/runs/ScopeRequestCard';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { useNotificationInbox } from '../components/shell/NotificationInboxContext';
import { useShellActions } from '../components/shell/ShellActionsContext';
import { TaskSpecView } from '../components/tasks/TaskSpecView';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { TaskTab } from '../lib/appNav';
import type { FeedState } from '../lib/feedState';
import { tintForState } from '../lib/feedState';
import { formatRelativeTimeFromIso } from '../lib/format';
import type {
  InboxBadge,
  InboxData,
  InboxFilter,
  InboxItem,
} from '../lib/inboxQueue';
import {
  buildInboxItems,
  filterInboxItems,
  groupInboxItems,
  INBOX_FILTER_LABEL,
  inboxItemActor,
  inboxItemBadge,
  inboxItemState,
  inboxItemText,
  isInboxItemRead,
  loadReadIds,
  markAllItemsRead,
  saveReadIds,
  specForTask,
  teammateOf,
  unreadInboxCount,
} from '../lib/inboxQueue';
import { resolveListKeyCommand } from '../lib/keyboard';
import { activityItems, memoryQueryKey } from '../lib/memory';
import { latestFailedAttemptByRunId } from '../lib/queueHistory';
import { cn } from '@/lib/utils';
import { GroupHeader } from '@/ui/ai/group-header';
import { IconButton } from '@/ui/ai/icon-button';
import { InitialsAvatar } from '@/ui/ai/initials-avatar';
import {
  DisplayIconButton,
  FilterIconButton,
  PageHeader,
} from '@/ui/ai/page-header';
import { LabelPill, PillButton } from '@/ui/ai/pill';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome/empty-state';
import { StateMark } from '@/ui/chrome/state-mark';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Skeleton } from '@/ui/skeleton';

interface InboxViewProps {
  /** The urgent feed sections plus unclaimed PRs — see `buildInbox`. */
  data: InboxData;
  /** The whole project: daemon-availability states, the question and approval maps for
   * inline answering, and the merge-queue actions on review rows. */
  project: DispatchProjectData;
  /** The first crumb segment; the page is `Inbox`. */
  projectName?: string | null;
  /** Keys the per-project read state in local storage; without one, read state lives only
   * for the life of the view. */
  projectRoot?: string | null;
  /** Opens the full task view on a given tab, pinned to one run. Defaults to the shell's
   * `openTask`. */
  onOpenTask?: (taskId: string, tab: TaskTab, runId?: string) => void;
  /** Opens the full-window review page for one repo pull request. */
  onOpenPr: (number: number) => void;
}

/** Which task tab a row's click lands on: asks about the diff go to the diff;
 * everything else lands in the conversation. */
function tabFor(state: FeedState): TaskTab {
  return state === 'review' || state === 'ruling' ? 'diff' : 'chat';
}

/** The live rows' read keys, tagged with the project they were loaded for so a project
 * switch can tell a set still waiting to be reloaded from the one it may persist. */
interface ReadState {
  root: string | null;
  ids: ReadonlySet<string>;
}

function loadReadState(root: string | null): ReadState {
  const ids =
    root === null || typeof window === 'undefined'
      ? new Set<string>()
      : loadReadIds(root, window.localStorage);
  return { root, ids };
}

/** The DOM id `aria-activedescendant` points at for one row. */
function rowDomId(key: string): string {
  return `inbox-${key}`;
}

const BADGE_ICON: Record<InboxBadge, typeof Check> = {
  check: Check,
  hand: Hand,
  merge: GitMerge,
  mention: AtSign,
  alert: CircleAlert,
  pr: GitPullRequest,
};

/**
 * The Inbox on Linear's two panes: a 348px list of everything waiting on you (the Control
 * room's urgent tiers, one row per task, plus ready-to-land runs and unclaimed PRs) merged
 * with the notification record of what already happened, and a right pane showing the
 * selected item — the question or approval card to answer inline, a PR summary, or the
 * task's spec with an `Open` pill. Rows are 48px with the actor's avatar and a tiny action
 * badge, a bright title while unread and a muted one once read, a 6px indigo dot before
 * unread titles, and the state glyph over the time on the right. `j`/`k` move, Enter opens.
 */
export function InboxView({
  data,
  project,
  projectName,
  projectRoot,
  onOpenTask,
  onOpenPr,
}: InboxViewProps) {
  const {
    portLoading,
    portError,
    portErrorDetail,
    client,
    retryEnsureDispatchd: onRetry,
  } = project;
  const inbox = useNotificationInbox();
  const shell = useShellActions();
  const openTask = onOpenTask ?? shell.openTask;
  const readRoot = projectRoot ?? null;

  const [filter, setFilter] = useState<InboxFilter>('all');
  const [groupByKind, setGroupByKind] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [readState, setReadState] = useState<ReadState>(() =>
    loadReadState(readRoot)
  );
  const readIds = readState.ids;
  const addReadId = (key: string) =>
    setReadState((prev) =>
      prev.ids.has(key) ? prev : { ...prev, ids: new Set([...prev.ids, key]) }
    );

  const items = useMemo(
    () => buildInboxItems(data, inbox.entries),
    [data, inbox.entries]
  );
  const visible = useMemo(
    () => filterInboxItems(items, filter),
    [items, filter]
  );
  const groups = useMemo(
    () =>
      groupByKind
        ? groupInboxItems(visible)
        : [{ id: 'all', label: 'All', state: null, items: visible }],
    [visible, groupByKind]
  );
  const unread = unreadInboxCount(items, readIds);
  const hasTeammateItems = items.some((item) => teammateOf(item) !== undefined);

  // A project switch reloads the set for the new root rather than carrying the old one over.
  useEffect(() => {
    if (readState.root !== readRoot) setReadState(loadReadState(readRoot));
  }, [readRoot, readState.root]);

  // Read state persists per project; keys of items no longer listed are dropped on save. Not
  // while the set is still the previous project's, and not before the daemon has answered —
  // the empty list before the first load would prune every stored key.
  useEffect(() => {
    if (readRoot === null || readState.root !== readRoot) return;
    if (portLoading || client === null || typeof window === 'undefined') return;
    saveReadIds(
      readRoot,
      readIds,
      new Set(items.map((item) => item.key)),
      window.localStorage
    );
  }, [readRoot, readState.root, readIds, items, portLoading, client]);

  // Runs whose latest merge-queue attempt failed. The feed indexes only live queue entries
  // (controlRoom.ts), so a run the queue bounced comes back here as an ordinary review row
  // with nothing saying why it is back; its row carries a `Failed to land` pill instead, so
  // this list and the Landing table's failed section tell one story. A run back in the live
  // queue is exempt — its pending attempt, not the old failure, is its story.
  const failedAttempts = useMemo(
    () => latestFailedAttemptByRunId(project.mergeQueue?.history ?? []),
    [project.mergeQueue]
  );
  const queuedRunIds = useMemo(
    () => new Set((project.mergeQueue?.entries ?? []).map((e) => e.runId)),
    [project.mergeQueue]
  );

  if (portLoading) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (portError || client === null) {
    return (
      <DaemonUnavailable
        starting={false}
        errorDetail={portErrorDetail}
        onRetry={onRetry}
      />
    );
  }

  const selected = visible.find((item) => item.key === selectedKey) ?? null;

  // Selecting a row reads it: live rows by key, notifications through the seam as well so
  // the persisted record agrees.
  function select(item: InboxItem) {
    setSelectedKey(item.key);
    addReadId(item.key);
    if (item.kind === 'notification' && !item.entry.read) {
      inbox.markRead(item.entry.id);
    }
  }

  function open(item: InboxItem) {
    switch (item.kind) {
      case 'ask':
        openTask(item.row.taskId, tabFor(item.row.state), item.row.runId);
        return;
      case 'landing':
        openTask(item.row.taskId, 'diff', item.row.runId);
        return;
      case 'pr':
        onOpenPr(item.pr.number);
        return;
      case 'notification':
        inbox.navigate(item.entry.target);
        return;
    }
  }

  function markAllRead() {
    inbox.markAllRead();
    setReadState((prev) => {
      const ids = markAllItemsRead(items, prev.ids);
      return ids === prev.ids ? prev : { ...prev, ids };
    });
  }

  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const command = resolveListKeyCommand(event, { isTyping: false });
    if (command === null) return;
    const index = visible.findIndex((item) => item.key === selectedKey);
    switch (command) {
      case 'list-down':
      case 'list-up': {
        event.preventDefault();
        if (visible.length === 0) return;
        const step = command === 'list-down' ? 1 : -1;
        const next =
          index === -1
            ? step === 1
              ? 0
              : visible.length - 1
            : Math.min(Math.max(index + step, 0), visible.length - 1);
        const item = visible[next];
        if (item !== undefined) select(item);
        return;
      }
      case 'list-confirm':
      case 'list-open':
        if (selected !== null) {
          event.preventDefault();
          open(selected);
        }
        return;
      case 'list-escape':
        setSelectedKey(null);
        return;
      default:
        return;
    }
  }

  // Everything a `Queue all for merge` would queue: reviewed runs are queued through the
  // project's own bulk action, ready-to-land ones one by one.
  const reviewRows =
    data.sections.find((section) => section.state === 'review')?.rows ?? [];
  const mergeable = reviewRows.length + data.readyToLand.length;
  function queueAllForMerge() {
    if (reviewRows.length > 0) void project.handleMergeAllReady();
    for (const row of data.readyToLand) {
      void project.handleEnqueueMerge(row.runId);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        crumb={[
          ...(projectName !== undefined && projectName !== null
            ? [projectName]
            : []),
          'Inbox',
        ]}
        actions={
          mergeable > 1 ? (
            <Button
              variant="ghost"
              onClick={queueAllForMerge}
              title="Queue every reviewed run for the merge queue — each still runs verify before landing"
            >
              Queue all for merge
            </Button>
          ) : undefined
        }
      />
      <div className="grid min-h-0 flex-1 grid-cols-[348px_minmax(0,1fr)]">
        <div
          data-slot="inbox-list-pane"
          className="shadow-hairline-right flex min-h-0 flex-col"
        >
          <div className="shadow-hairline-bottom flex h-11 shrink-0 items-center gap-1 pr-2 pl-4">
            <span className="text-foreground text-[13px] font-medium">
              Inbox
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<IconButton label="Inbox options" />}
              >
                <MoreHorizontal aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={markAllRead}>
                  <CheckCheck />
                  Mark all as read
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => shell.setProjectView('overview')}
                >
                  Open Control room
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="flex-1" />
            <IconButton
              label="Mark all as read"
              onClick={markAllRead}
              disabled={unread === 0}
            >
              <CheckCheck aria-hidden />
            </IconButton>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<FilterIconButton active={filter !== 'all'} />}
              />
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup
                  value={filter}
                  onValueChange={(value) => setFilter(value as InboxFilter)}
                >
                  {(Object.keys(INBOX_FILTER_LABEL) as InboxFilter[])
                    // No Teammates option on a board nobody else works on.
                    .filter(
                      (value) => value !== 'teammates' || hasTeammateItems
                    )
                    .map((value) => (
                      <DropdownMenuRadioItem key={value} value={value}>
                        {INBOX_FILTER_LABEL[value]}
                      </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<DisplayIconButton active={groupByKind} />}
              />
              <DropdownMenuContent align="end">
                <DropdownMenuCheckboxItem
                  checked={groupByKind}
                  onCheckedChange={(checked) => setGroupByKind(checked)}
                >
                  Group by kind
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div
            role="listbox"
            aria-label="Inbox"
            aria-activedescendant={
              selected !== null ? rowDomId(selected.key) : undefined
            }
            tabIndex={0}
            onKeyDown={onListKeyDown}
            className="min-h-0 flex-1 overflow-y-auto px-2 py-1 outline-none"
          >
            {visible.length === 0 ? (
              <EmptyState
                heading={
                  filter === 'earlier'
                    ? 'Nothing has happened yet'
                    : 'Nothing waiting on you'
                }
                description={
                  filter === 'all'
                    ? 'Questions, approvals, reviews and what already happened land here.'
                    : undefined
                }
              />
            ) : (
              groups.map((group) => (
                <div
                  key={group.id}
                  role="group"
                  aria-label={group.label}
                  data-inbox-group={group.id}
                >
                  {groupByKind && (
                    <GroupHeader
                      tint={
                        group.state !== null
                          ? tintForState(group.state)
                          : undefined
                      }
                      icon={
                        group.state !== null ? (
                          <StateMark state={group.state} />
                        ) : undefined
                      }
                      name={group.label}
                      count={group.items.length}
                      className="mt-1"
                    />
                  )}
                  {group.items.map((item) => {
                    const failedAttempt =
                      item.kind === 'ask' &&
                      item.row.state === 'review' &&
                      !queuedRunIds.has(item.row.runId)
                        ? failedAttempts.get(item.row.runId)
                        : undefined;
                    const mergeRow =
                      item.kind === 'landing' ||
                      (item.kind === 'ask' && item.row.state === 'review')
                        ? item.row
                        : null;
                    return (
                      <InboxRow
                        key={item.key}
                        item={item}
                        read={isInboxItemRead(item, readIds)}
                        selected={item.key === selectedKey}
                        onSelect={() => select(item)}
                        onOpen={() => open(item)}
                        badge={
                          failedAttempt !== undefined ||
                          teammateOf(item) !== undefined ? (
                            <>
                              {failedAttempt !== undefined && (
                                <LabelPill
                                  color="var(--state-failed-fg)"
                                  title={failedAttempt.reason}
                                >
                                  Failed to land
                                </LabelPill>
                              )}
                              {teammateOf(item) !== undefined && (
                                // Whose it is, so a teammate's parked approval
                                // reads as theirs to answer, not yours.
                                <LabelPill
                                  color="var(--text-secondary)"
                                  title="Dispatched by a teammate — theirs to answer"
                                >
                                  {ownerLabel(teammateOf(item))}
                                </LabelPill>
                              )}
                            </>
                          ) : undefined
                        }
                        action={
                          mergeRow !== null ? (
                            <IconButton
                              label={`Queue merge: ${mergeRow.title}`}
                              title="Queue this run for merge"
                              onClick={(event) => {
                                event.stopPropagation();
                                void project.handleEnqueueMerge(mergeRow.runId);
                              }}
                            >
                              <GitMerge aria-hidden />
                            </IconButton>
                          ) : undefined
                        }
                      />
                    );
                  })}
                </div>
              ))
            )}
          </div>
          <YourMemory client={client} port={project.port} />
        </div>
        <div
          data-slot="inbox-detail-pane"
          className="flex min-h-0 flex-col overflow-y-auto"
        >
          {selected === null ? (
            <EmptyState
              illustration={<InboxArt />}
              heading={`${unread} unread`}
              description={
                unread === 0
                  ? 'Nothing waiting on you. Anything an agent asks lands here.'
                  : 'Pick a notification to read it here.'
              }
              className="flex-1"
            />
          ) : (
            <DetailPane
              item={selected}
              project={project}
              onOpen={() => open(selected)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** The caller's own personal-memory activity from the last day, each change
 *  with an Undo. Hidden when there is none, or when the daemon answers no
 *  activity for this caller (no memory, or no human behind the window). */
function YourMemory({
  client,
  port,
}: {
  client: Pick<ApiClient, 'memoryActivity' | 'undoMemory'>;
  port: number | undefined;
}) {
  const { data } = useQuery({
    queryKey: memoryQueryKey(port, 'activity'),
    queryFn: () => client.memoryActivity(),
    retry: false,
  });
  const items = activityItems(data?.activity ?? []);
  if (items.length === 0) return null;
  return (
    <section
      aria-label="Your memory"
      className="shadow-hairline-top flex max-h-[40%] min-h-0 shrink-0 flex-col overflow-y-auto px-2 py-1"
    >
      <GroupHeader name="Your memory" count={items.length} />
      <MemoryActivityList items={items} client={client} />
    </section>
  );
}

/** One 48px inbox row: the actor's 28px avatar carrying a 12px action badge, the title line
 * (6px indigo dot while unread, muted once read) over a 12px subtitle, and the 14px state
 * glyph over the relative time at the right. Selection is the neutral selected surface. */
/** `human:ada` → `ada's`, for the row badge. */
function ownerLabel(ref: string | undefined): string {
  return `${(ref ?? '').replace(/^human:/, '')}'s`;
}

function InboxRow({
  item,
  read,
  selected,
  onSelect,
  onOpen,
  badge,
  action,
}: {
  item: InboxItem;
  read: boolean;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  /** A pill after the title (`Failed to land`). */
  badge?: ReactNode;
  /** A hover-revealed control at the row's right (queue for merge). */
  action?: ReactNode;
}) {
  const { id, title, subtitle } = inboxItemText(item);
  const Badge = BADGE_ICON[inboxItemBadge(item)];
  return (
    <div
      id={rowDomId(item.key)}
      role="option"
      aria-selected={selected}
      data-slot="inbox-row"
      data-key={item.key}
      data-read={read || undefined}
      tabIndex={-1}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cn(
        'group/row flex h-12 cursor-pointer items-center gap-3 rounded-control px-2 transition-colors duration-100 hover:bg-surface-hover',
        selected && 'bg-surface-selected hover:bg-surface-selected'
      )}
    >
      <span className="relative shrink-0">
        <InitialsAvatar
          name={inboxItemActor(item)}
          className="size-7 text-[11px]"
        />
        <span
          aria-hidden
          data-slot="inbox-badge"
          className="bg-surface-active text-foreground shadow-hairline absolute -right-0.5 -bottom-0.5 flex size-3 items-center justify-center rounded-full [&_svg]:size-2"
        >
          <Badge strokeWidth={2.5} />
        </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-4">
          {!read && (
            <span
              role="img"
              aria-label="Unread"
              data-slot="unread-dot"
              className="bg-primary size-1.5 shrink-0 rounded-full"
            />
          )}
          {id !== null && (
            <span className="font-book text-muted-foreground shrink-0 tracking-(--id-tracking)">
              {id}
            </span>
          )}
          <span
            data-slot="inbox-title"
            className={cn(
              'min-w-0 truncate font-medium',
              read ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {title}
          </span>
          {badge}
        </span>
        <span className="font-book text-muted-foreground truncate text-[12px] leading-4">
          {subtitle}
        </span>
      </span>
      {action !== undefined && (
        <span className="shrink-0 opacity-0 transition-opacity duration-100 group-hover/row:opacity-100 focus-within:opacity-100">
          {action}
        </span>
      )}
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <StateMark state={inboxItemState(item)} />
        <span className="font-book text-muted-foreground text-[12px] leading-4">
          {formatRelativeTimeFromIso(item.ts)}
        </span>
      </span>
    </div>
  );
}

/** The right pane: a 44px header naming the item with the `Open` pill, then the thing
 * itself — the question or approval to answer inline, the task's spec, a PR summary, or
 * the recorded notification. */
function DetailPane({
  item,
  project,
  onOpen,
}: {
  item: InboxItem;
  project: DispatchProjectData;
  onOpen: () => void;
}) {
  const { id, title } = inboxItemText(item);
  return (
    <>
      <div className="shadow-hairline-bottom flex h-11 shrink-0 items-center gap-2 px-4">
        {id !== null && (
          <span className="font-book text-muted-foreground shrink-0 text-[13px] tracking-(--id-tracking)">
            {id}
          </span>
        )}
        <span className="text-foreground min-w-0 flex-1 truncate text-[13px] font-medium">
          {title}
        </span>
        <PillButton onClick={onOpen}>Open</PillButton>
      </div>
      <DetailBody item={item} project={project} />
    </>
  );
}

function DetailBody({
  item,
  project,
}: {
  item: InboxItem;
  project: DispatchProjectData;
}) {
  switch (item.kind) {
    case 'ask': {
      const { row } = item;
      if (row.state === 'answer') {
        const questions = project.openQuestions?.get(row.runId) ?? [];
        const scope = project.pendingScopeRequests?.get(row.runId);
        if (questions.length > 0 || scope !== undefined) {
          return (
            <div className="flex flex-col gap-3 p-4">
              {questions.map((question) => (
                <QuestionCard
                  key={question.id}
                  question={question.question}
                  options={question.options}
                  askedAt={question.askedAt}
                  onAnswer={(answer) =>
                    project.handleAnswerQuestion(row.runId, question.id, answer)
                  }
                />
              ))}
              {scope !== undefined && (
                <ScopeRequestCard
                  paths={scope.paths}
                  reason={scope.reason}
                  onDecide={(granted) =>
                    project.handleDecideScopeRequest(
                      row.runId,
                      scope.id,
                      granted
                    )
                  }
                  availability={project.scopeDecide}
                  onRestartDaemon={project.handleRestartDaemon}
                />
              )}
            </div>
          );
        }
      }
      if (row.state === 'approve') {
        const calls = project.pendingApprovals?.get(row.runId) ?? [];
        if (calls.length > 0) {
          return (
            <div className="flex flex-col gap-3 p-4">
              {calls.map((call) => (
                <ApprovalCard
                  key={call.requestId}
                  toolName={call.toolName}
                  toolInput={call.input}
                  truncated={call.truncated}
                  loadFullInput={() =>
                    project.fetchApprovalInput(row.runId, call.requestId)
                  }
                  frozenSince={row.since}
                  onDecide={(allow, opts) =>
                    project.handleApprove(
                      row.runId,
                      call.requestId,
                      allow,
                      opts
                    )
                  }
                  availability={project.scopeDecide}
                  onRestartDaemon={project.handleRestartDaemon}
                />
              ))}
            </div>
          );
        }
      }
      return <TaskSummary taskId={row.taskId} project={project} />;
    }
    case 'landing':
      return <TaskSummary taskId={item.row.taskId} project={project} />;
    case 'pr':
      return <PrSummary pr={item.pr} />;
    case 'notification':
      return (
        <div className="flex flex-col gap-2 p-4">
          <p className="text-foreground text-[15px] font-semibold">
            {item.entry.title}
          </p>
          <p className="font-book text-foreground text-[15px] leading-6">
            {item.entry.body}
          </p>
          <p className="font-book text-muted-foreground text-[12px]">
            {formatRelativeTimeFromIso(item.entry.ts)}
          </p>
        </div>
      );
  }
}

/** The task's spec (`TaskSpecView`) when the task is loaded; a task the project no longer
 * lists (archived, or the run outlived it) falls back to its id. */
function TaskSummary({
  taskId,
  project,
}: {
  taskId: string;
  project: DispatchProjectData;
}) {
  const tasks = project.tasksIncludingArchived ?? project.tasks ?? [];
  const doc = tasks.find((t) => t.meta.id === taskId);
  if (doc === undefined) {
    return (
      <EmptyState
        heading="Task not loaded"
        description={`${taskId} is not in this project's task list.`}
      />
    );
  }
  return <TaskSpecView spec={specForTask(doc, tasks)} />;
}

/** A standalone repo PR — no local run, so there is nothing to answer here; the summary
 * names it and `Open` goes to the PR review page. */
function PrSummary({ pr }: { pr: RepoPr }) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <h2 className="text-foreground text-[24px] leading-8 font-semibold tracking-[-0.16px] text-pretty">
        {pr.title}
      </h2>
      <p className="font-book text-muted-foreground text-[13px]">
        #{pr.number} by {pr.author} · {pr.headRefName} → {pr.baseRefName}
        {pr.isDraft ? ' · Draft' : ''}
      </p>
      <p className="font-book text-muted-foreground text-[12px]">
        Updated {formatRelativeTimeFromIso(pr.updatedAt)}
      </p>
    </div>
  );
}

/** §14's line-art: a 60px inbox tray, stroked at 1px. */
function InboxArt() {
  return (
    <svg
      viewBox="0 0 60 60"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10 33 L16 15 H44 L50 33 V47 H10 Z" />
      <path d="M10 33 H22 L26 39 H34 L38 33 H50" />
      <path d="M24 23 H36 M22 28 H38" />
    </svg>
  );
}
