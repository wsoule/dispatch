import type { InboxItem, InboxKind } from '@dispatch/client';
import { Bot, CircleHelp, Inbox, RefreshCw, Sparkles, X } from 'lucide-react';
import { Fragment, useMemo, useRef, useState } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { useToasts } from '../components/shell/Toasts';
import { BackToTasks } from '../components/tasks/BackToTasks';
import { StatusIcon } from '../components/tasks/StatusIcon';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import {
  BRAIN_DUMP_DRAFT_KEY,
  usePersistedDraft,
} from '../hooks/usePersistedDraft';
import { triageHints } from '../lib/judgmentBadges';
import { buildMilestonePrompt } from '../lib/milestonePrompt';
import { formatShortDate } from '../lib/taskDates';
import { cn } from '@/lib/utils';
import { GroupHeader } from '@/ui/ai/group-header';
import { IconButton } from '@/ui/ai/icon-button';
import { ListRow } from '@/ui/ai/list-row';
import { PageHeader } from '@/ui/ai/page-header';
import { LabelPill, Pill, PillButton } from '@/ui/ai/pill';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';
import { Kbd } from '@/ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Textarea } from '@/ui/textarea';

const CLUSTER_MIN_ITEMS = 3;

interface BrainDumpViewProps {
  data: DispatchProjectData;
  onPlanText: (text: string) => void;
  onOpenTask: (taskId: string) => void;
  /** Two views: starts the header with "‹ tasks"; Classic leaves it out. */
  onBack?: () => void;
}

// Only the kinds that carry information get a pill — a bug's dot is the app's red, an
// idea's the in-progress yellow. 'task' and 'note' are the unremarkable default and render
// nothing: a rail of same-toned chips said nothing worth the width.
const KIND_DOT: Partial<Record<InboxKind, string>> = {
  bug: 'var(--red)',
  idea: 'var(--status-progress)',
};
const KIND_LABEL: Partial<Record<InboxKind, string>> = {
  bug: 'Bug',
  idea: 'Idea',
};

// The comment-card surface (§8) the capture composer and the inline editor sit on:
// quaternary, 8px radius, a half-pixel strong ring.
const CARD_CLASS =
  'bg-surface-quaternary rounded-card border-border-strong border-[0.5px] p-3';
// Group cards take the board card's surface (§5) instead: the half-pixel light ring and
// soft drop of `shadow-card`.
const GROUP_CARD_CLASS = 'bg-surface-quaternary rounded-card shadow-card p-3';

/**
 * Brain dump — everything you notice, before you decide whether it matters.
 *
 * The premise is that capture and commitment are separate acts, and that most of what lands here
 * is noise. So nothing in this screen asks you to categorise, prioritise or estimate: you type,
 * it splits on newlines, each line gets a guessed kind, and it waits. Sorting is a later,
 * optional act — hence the copy, which is load-bearing rather than decorative.
 *
 * Replaces Notes & triage, and absorbs its agent channel: items an agent flagged mid-run through
 * the MCP `dispatch_note` tool land here too, marked so you can tell them from your own.
 */
export function BrainDumpView({
  data,
  onPlanText,
  onOpenTask,
  onBack,
}: BrainDumpViewProps) {
  const toasts = useToasts();
  // Shared with the ⌘D quick-capture modal and persisted across navigation and
  // relaunch — leaving this screen must not cost half-typed thoughts.
  const [draft, setDraft] = usePersistedDraft(BRAIN_DUMP_DRAFT_KEY);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // The last row whose checkbox was plainly clicked — the anchor a shift-click
  // extends from, file-manager style.
  const [anchorId, setAnchorId] = useState<string | null>(null);
  // `ListRow` reports a checkbox toggle without its pointer event, so the shift state is
  // read off the click on its way down (capture phase) and consumed by the toggle.
  const shiftHeld = useRef(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The one open "Add detail" editor, carrying the row it belongs to and its unsaved text.
  // One slot, deliberately: two half-edited rows at once is a way to lose an edit.
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(
    null
  );
  // Grouping runs only when asked (the Group button) — a model call is a bill, and typing
  // into your own inbox must never ring one up on a timer. The rendered groups come from
  // `data.inboxClusters`, the pass persisted server-side, so a page load shows the last
  // answer instead of re-asking.
  const [grouping, setGrouping] = useState(false);
  const [clusterError, setClusterError] = useState<string | null>(null);

  const inbox = data.inbox;
  const open = useMemo(() => inbox.filter((i) => !i.done), [inbox]);
  const sorted = useMemo(() => inbox.filter((i) => i.done), [inbox]);
  const openItemIds = useMemo(() => open.map((i) => i.id), [open]);

  // The persisted groups, filtered to items that are still open — converting or dismissing
  // half a group must not leave it claiming members it no longer has.
  const groups = useMemo(() => {
    if (data.inboxClusters === null) return null;
    const openIds = new Set(openItemIds);
    return data.inboxClusters.groups
      .map((g) => ({
        ...g,
        itemIds: g.itemIds.filter((id) => openIds.has(id)),
      }))
      .filter((g) => g.itemIds.length >= 2);
  }, [data.inboxClusters, openItemIds]);

  // Whether the open set has drifted from what the last pass covered — the nudge to re-group,
  // in place of the old auto-run.
  const groupsStale = useMemo(() => {
    if (data.inboxClusters === null) return false;
    const covered = new Set(data.inboxClusters.itemIds);
    return (
      covered.size !== openItemIds.length ||
      openItemIds.some((id) => !covered.has(id))
    );
  }, [data.inboxClusters, openItemIds]);

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PageHeader
          leading={onBack && <BackToTasks onBack={onBack} />}
          crumb={['Notes']}
        />
        <div className="px-6 py-4">
          <DaemonUnavailable
            starting={data.portLoading}
            errorDetail={data.portErrorDetail}
            onRetry={data.retryEnsureDispatchd}
          />
        </div>
      </div>
    );
  }

  // Plain click toggles one row and moves the anchor; shift-click applies the clicked row's
  // new state to every row between the anchor and it, and leaves the anchor where it was.
  function toggle(id: string, shiftKey: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shiftKey && anchorId !== null && anchorId !== id) {
        const ids = openItemIds;
        const from = ids.indexOf(anchorId);
        const to = ids.indexOf(id);
        if (from !== -1 && to !== -1) {
          const turnOn = !prev.has(id);
          const [lo, hi] = from < to ? [from, to] : [to, from];
          for (const rangeId of ids.slice(lo, hi + 1)) {
            if (turnOn) next.add(rangeId);
            else next.delete(rangeId);
          }
          return next;
        }
      }
      if (!next.delete(id)) next.add(id);
      return next;
    });
    if (!shiftKey) setAnchorId(id);
  }

  async function guard(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function capture(): void {
    void guard(async () => {
      await data.handleCaptureInbox(draft);
      setDraft('');
    });
  }

  function convert(ids: string[]): void {
    void guard(async () => {
      const res = await data.handleConvertInbox(ids);
      setSelected(new Set());
      // A batch that half-lands has to say so rather than looking like a success.
      if (res.failed > 0) {
        const first = res.results.find((r) => r.error !== undefined)?.error;
        setError(
          `${res.converted} converted, ${res.failed} failed${first === undefined ? '' : `: ${first}`}`
        );
        return;
      }
      const firstTask = res.results.find((r) => r.taskId !== undefined)?.taskId;
      if (res.converted === 1 && firstTask !== undefined) {
        // The one-item case gets follow-ups on the toast itself: open it, or hand it
        // straight to AI enrichment — the thing a one-liner task usually needs next.
        toasts.push({
          tone: 'success',
          title: 'Task created',
          action: {
            label: (
              <span className="flex items-center gap-1">
                <Sparkles className="size-3" aria-hidden />
                Add detail
              </span>
            ),
            onClick: () => {
              onOpenTask(firstTask);
              void data.handleEnrichTask(firstTask);
            },
          },
          secondary: {
            label: 'View task',
            onClick: () => onOpenTask(firstTask),
          },
        });
      } else if (res.converted > 1) {
        toasts.push({
          tone: 'success',
          title: `${res.converted} tasks created`,
        });
      }
      // The triage's duplicate reading rides on the result: the task exists
      // either way, so this is a nudge to go look, never a block.
      for (const result of res.results) {
        if (result.duplicateOf === undefined) continue;
        const duplicateOf = result.duplicateOf;
        toasts.push({
          tone: 'info',
          title: `Looks like a duplicate of ${duplicateOf}`,
          action: {
            label: 'View existing',
            onClick: () => onOpenTask(duplicateOf),
          },
        });
      }
    });
  }

  // Runs one grouping pass — the Group button, and the only path that bills a model call.
  function runCluster(): void {
    if (grouping) return; // one call in flight at a time — a second would be a second bill
    setGrouping(true);
    setClusterError(null);
    void (async () => {
      try {
        const { error: clusterErr } = await data.handleClusterInbox();
        setClusterError(clusterErr);
      } catch (err) {
        setClusterError(err instanceof Error ? err.message : String(err));
      } finally {
        setGrouping(false);
      }
    })();
  }

  // Opens the inline editor on one row, seeded with what that row already says. Nothing is
  // fetched or drafted here — the text is already in hand, so opening costs no request.
  function addDetail(item: InboxItem): void {
    setEditing({ id: item.id, text: item.text });
  }

  // Tapping the row's text drops the editor down under it; tapping again folds it back up.
  function toggleDetail(item: InboxItem): void {
    if (editing?.id === item.id) setEditing(null);
    else addDetail(item);
  }

  // Writes the edited text back onto the item and closes the editor. An empty body is refused
  // rather than saved: a blank row is unreadable in the list and unrecoverable from it. `busy`
  // is checked here too — ⌘⏎ reaches this without going through the disabled Save button, and
  // a second pass mid-flight would be a second PATCH. A failed save leaves the editor open
  // with the text still in it, so nothing typed is lost to a daemon that said no.
  function saveDetail(): void {
    if (busy || editing === null || editing.text.trim() === '') return;
    const { id, text } = editing;
    void guard(async () => {
      await data.handleUpdateInboxItem(id, { text });
      setEditing(null);
    });
  }

  function dismiss(ids: string[]): void {
    void guard(async () => {
      await data.handleDismissInbox(ids);
      setSelected(new Set());
    });
  }

  const selectedItems = () => open.filter((i) => selected.has(i.id));

  const groupsEmptyCopy =
    openItemIds.length < CLUSTER_MIN_ITEMS
      ? 'Capture a few more to enable grouping.'
      : groups === null
        ? 'Group asks a model which captures are one piece of work.'
        : 'Nothing here looks related.';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        leading={onBack && <BackToTasks onBack={onBack} />}
        crumb={['Notes']}
        actions={<ExplainerPopover />}
      />

      <div
        className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
        onClickCapture={(e) => {
          shiftHeld.current = e.shiftKey;
        }}
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
          <div className={CARD_CLASS}>
            {/* `field-sizing-fixed` cancels the primitive's `field-sizing-content`: this box
                stays a draggable 92px rather than growing with what you type. */}
            <Textarea
              variant="borderless"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // ⌘⏎ commits, matching the legend in the explainer. Plain Enter has to stay a
                // newline — the whole point is dumping several thoughts at once.
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (draft.trim() !== '') capture();
                }
              }}
              placeholder="Dump it here…"
              className="field-sizing-fixed min-h-[92px] resize-y text-[15px] leading-6"
            />
            <div className="mt-2 flex items-center gap-2">
              <span className="flex-1" />
              <PillButton
                disabled={draft.trim() === '' || busy}
                onClick={() => onPlanText(draft)}
              >
                <Sparkles />
                Plan
              </PillButton>
              <Button disabled={draft.trim() === '' || busy} onClick={capture}>
                <Inbox />
                Drop into the inbox
              </Button>
            </div>
          </div>

          {error !== null && (
            <p role="alert" className="text-red text-[13px]">
              {error}
            </p>
          )}

          {selected.size > 0 && (
            <div className="bg-surface-quaternary rounded-card border-border-strong flex h-9 items-center gap-2 border-[0.5px] px-3">
              <span className="text-[13px] font-medium">
                {selected.size} selected
              </span>
              <span className="flex-1" />
              <Button onClick={() => convert([...selected])} disabled={busy}>
                Make tasks
              </Button>
              <PillButton
                onClick={() =>
                  onPlanText(
                    buildMilestonePrompt({
                      items: selectedItems().map((i) => i.text),
                    })
                  )
                }
                disabled={busy}
              >
                Plan as milestone
              </PillButton>
              <PillButton
                onClick={() => dismiss([...selected])}
                disabled={busy}
              >
                Dismiss
              </PillButton>
              <PillButton
                onClick={() => setSelected(new Set())}
                disabled={busy}
              >
                Clear
              </PillButton>
            </div>
          )}

          {/* Sits above the inbox list on purpose: the structural hint should land before the
              raw items, so grouping is the first thing considered rather than an afterthought. */}
          <section aria-label="Grouped" className="flex flex-col gap-2">
            <GroupHeader
              name="Grouped"
              count={groups?.length ?? 0}
              actions={
                <span className="flex items-center gap-2">
                  {groupsStale && !grouping && (
                    <span className="font-book text-muted-foreground text-[12px]">
                      The list changed since this grouping.
                    </span>
                  )}
                  {clusterError !== null && (
                    <span
                      className="text-red max-w-64 truncate text-[12px]"
                      title={clusterError}
                    >
                      {clusterError}
                    </span>
                  )}
                  <PillButton
                    onClick={runCluster}
                    disabled={
                      grouping || openItemIds.length < CLUSTER_MIN_ITEMS
                    }
                  >
                    <RefreshCw
                      className={cn(
                        grouping && 'animate-spin motion-reduce:animate-none'
                      )}
                    />
                    {grouping ? 'Grouping…' : 'Group'}
                  </PillButton>
                </span>
              }
            />
            {groups === null || groups.length === 0 ? (
              <EmptyState description={groupsEmptyCopy} className="py-3" />
            ) : (
              <ul className="flex flex-col gap-2">
                {groups.map((g) => (
                  <li key={g.epicTitle} className={GROUP_CARD_CLASS}>
                    <div className="text-[13px] font-medium">{g.epicTitle}</div>
                    <p className="font-book text-muted-foreground mt-1 text-[12px] leading-5">
                      {g.reason}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <span className="font-book text-muted-foreground text-[12px]">
                        {g.itemIds.length} items
                      </span>
                      <span className="flex-1" />
                      <PillButton
                        onClick={() => setSelected(new Set(g.itemIds))}
                      >
                        Select
                      </PillButton>
                      <PillButton
                        onClick={() =>
                          onPlanText(
                            buildMilestonePrompt({
                              title: g.epicTitle,
                              reason: g.reason,
                              items: inbox
                                .filter((i) => g.itemIds.includes(i.id))
                                .map((i) => i.text),
                            })
                          )
                        }
                      >
                        Plan as milestone
                      </PillButton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Inbox" className="flex flex-col gap-1">
            <GroupHeader name="Inbox" count={open.length} />
            {open.length === 0 ? (
              <EmptyState
                icon={Inbox}
                heading="Nothing captured yet"
                description="Type above — it costs nothing."
              />
            ) : (
              <div role="table" aria-label="Inbox items">
                {open.map((it) => (
                  <Fragment key={it.id}>
                    <InboxRow
                      item={it}
                      hints={triageHints(it, data.inboxTriage?.items[it.id])}
                      selected={selected.has(it.id)}
                      busy={busy}
                      editing={editing?.id === it.id}
                      onToggle={() => toggle(it.id, shiftHeld.current)}
                      onMakeTask={() => convert([it.id])}
                      onAddDetail={() => addDetail(it)}
                      onToggleDetail={() => toggleDetail(it)}
                      onPlan={() => onPlanText(it.text)}
                      onDismiss={() => dismiss([it.id])}
                    />
                    {/* The editor belongs to at most one row at a time — rendered right under
                        it, not in a modal, so saving or cancelling stays in the flow of the
                        list. */}
                    {editing?.id === it.id && (
                      <div className={cn(CARD_CLASS, 'my-1 ml-9')}>
                        <Textarea
                          variant="borderless"
                          value={editing.text}
                          autoFocus
                          aria-label={`Edit "${firstLine(it.text)}"`}
                          onChange={(e) =>
                            setEditing({ id: it.id, text: e.target.value })
                          }
                          onKeyDown={(e) => {
                            // ⌘⏎ saves, matching the capture box above; Escape cancels. Plain
                            // Enter stays a newline — detail is usually more than one line.
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                              e.preventDefault();
                              saveDetail();
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              setEditing(null);
                            }
                          }}
                          className="min-h-[72px] resize-y text-[15px] leading-6"
                        />
                        <div className="mt-2 flex items-center gap-2">
                          <span className="flex-1" />
                          <PillButton
                            onClick={() => setEditing(null)}
                            disabled={busy}
                          >
                            Cancel
                          </PillButton>
                          <Button
                            onClick={saveDetail}
                            disabled={busy || editing.text.trim() === ''}
                          >
                            Save
                          </Button>
                        </div>
                      </div>
                    )}
                  </Fragment>
                ))}
              </div>
            )}
          </section>

          {sorted.length > 0 && (
            <section aria-label="Archived" className="flex flex-col gap-1">
              <GroupHeader
                name="Archived"
                count={sorted.length}
                collapsed={!archiveOpen}
                onToggle={() => setArchiveOpen((v) => !v)}
              />
              {archiveOpen && (
                <div role="table" aria-label="Archived items">
                  {sorted.map((it) => (
                    <ListRow
                      key={it.id}
                      status={
                        <StatusIcon
                          status={
                            it.linkedTaskId === null ? 'dropped' : 'landed'
                          }
                        />
                      }
                      title={
                        <span className="text-muted-foreground font-book">
                          {firstLine(it.text)}
                        </span>
                      }
                      trailing={
                        <>
                          <KindPill kind={it.kind} />
                          {it.linkedTaskId === null ? (
                            <Pill>Dismissed</Pill>
                          ) : (
                            <button
                              type="button"
                              onClick={() => onOpenTask(it.linkedTaskId ?? '')}
                              className="rounded-pill focus-visible:ring-ring outline-none focus-visible:ring-2"
                            >
                              <Pill>→ {it.linkedTaskId}</Pill>
                            </button>
                          )}
                        </>
                      }
                      date={formatShortDate(it.created)}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

// Reveals the explainer prose on hover, click, or keyboard focus — controlled state, since
// the Popover only opens on click by default. Escape or a click outside dismisses it.
function ExplainerPopover() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Moving the pointer away must not close an explainer the user tabbed or clicked into,
  // which would otherwise leave a focused trigger with nothing showing.
  function closeUnlessTriggerFocused() {
    if (document.activeElement !== triggerRef.current) setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            ref={triggerRef}
            variant="ghost"
            size="sm"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={closeUnlessTriggerFocused}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            // Suppresses the trigger's own click-to-toggle, which would close a popover that
            // hovering or focusing the button has already opened.
            onClick={(e) => e.preventDefault()}
          />
        }
      >
        <CircleHelp />
        What is this?
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        // The popover would focus its content on open, blurring the trigger and closing
        // this straight back up; keeping focus on the trigger is what makes Tab reveal it.
        initialFocus={false}
        finalFocus={false}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={closeUnlessTriggerFocused}
        className="flex flex-col gap-3 p-3"
      >
        <ExplainerSection heading="Group into milestones">
          Group asks a model which of your captures are really one piece of
          work. It runs only when you press it, and the last answer sticks
          around between visits.
        </ExplainerSection>
        <ExplainerSection heading="How this works">
          Nothing here is a commitment. Items sit in the inbox until you make
          them tasks, hand them to the planner, or dismiss them. Everything is
          written to your own file under{' '}
          <code className="font-mono text-[12px]">.dispatch/inbox/</code> in
          your repo — edit it by hand any time.
        </ExplainerSection>
        <div>
          <h4 className="text-muted-foreground text-[12px] font-medium">
            Keyboard
          </h4>
          <dl className="mt-1.5 flex flex-col gap-1.5">
            <Key combo="⌘⏎" what="drop into the inbox" />
            <Key combo="⇧ click" what="select a range of items" />
          </dl>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ExplainerSection({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4 className="text-muted-foreground text-[12px] font-medium">
        {heading}
      </h4>
      <p className="font-book text-muted-foreground mt-1 text-[13px] leading-5">
        {children}
      </p>
    </div>
  );
}

function Key({ combo, what }: { combo: string; what: string }) {
  return (
    <div className="flex items-center gap-2">
      <dt>
        <Kbd>{combo}</Kbd>
      </dt>
      <dd className="font-book text-muted-foreground text-[12px]">{what}</dd>
    </div>
  );
}

/** The kind pill — a `LabelPill` with the kind's dot, or nothing for the unremarkable kinds. */
function KindPill({ kind }: { kind: InboxKind }) {
  const dot = KIND_DOT[kind];
  if (dot === undefined) return null;
  return <LabelPill color={dot}>{KIND_LABEL[kind] ?? kind}</LabelPill>;
}

function InboxRow({
  item,
  hints,
  selected,
  busy,
  editing,
  onToggle,
  onMakeTask,
  onAddDetail,
  onToggleDetail,
  onPlan,
  onDismiss,
}: {
  item: InboxItem;
  /** What the triage judged (see `triageHints`); empty when it agrees or has not run. */
  hints: string[];
  selected: boolean;
  busy: boolean;
  /** Whether this row's own inline editor is open — disables just its "Add detail" button,
   * distinct from `busy` (every button in the view). */
  editing: boolean;
  onToggle: () => void;
  onMakeTask: () => void;
  onAddDetail: () => void;
  /** Tapping the row's text — drops the editor down, or folds it back up. */
  onToggleDetail: () => void;
  onPlan: () => void;
  onDismiss: () => void;
}) {
  const extra = extraLines(item.text);
  return (
    <ListRow
      selected={selected}
      onSelectToggle={onToggle}
      selectLabel={`Select "${item.text}"`}
      title={
        // First line only in the row; the rest lives one tap away in the drop-down.
        // A real button so the whole-text affordance is keyboard reachable too.
        <button
          type="button"
          onClick={onToggleDetail}
          aria-expanded={editing}
          className="max-w-full cursor-pointer truncate text-left font-medium outline-none"
        >
          {firstLine(item.text)}
        </button>
      }
      trailing={
        <>
          {extra > 0 && (
            <span className="font-book text-muted-foreground text-[12px]">
              +{extra} more
            </span>
          )}
          {/* Items an agent flagged mid-run are marked, so you can tell what you noticed
              yourself from what something else noticed for you. */}
          {item.createdByRunId !== null && (
            <span
              role="img"
              className="shrink-0"
              title={`Flagged by ${item.createdByRunId}`}
              aria-label={`Flagged by agent run ${item.createdByRunId}`}
            >
              <Bot className="text-muted-foreground size-3.5" />
            </span>
          )}
          <KindPill kind={item.kind} />
          {hints.map((hint) => (
            <LabelPill key={hint} color="var(--state-waiting-fg)">
              {hint}
            </LabelPill>
          ))}
          <span className="flex items-center gap-1 opacity-0 transition-opacity duration-100 group-hover/row:opacity-100 focus-within:opacity-100">
            <PillButton onClick={onMakeTask} disabled={busy}>
              Make a task
            </PillButton>
            {/* Opens the line for editing in place — the thing a one-liner is usually
                missing is detail its author already has in their head. */}
            <PillButton onClick={onAddDetail} disabled={busy || editing}>
              Add detail
            </PillButton>
            <PillButton onClick={onPlan} disabled={busy}>
              Plan
            </PillButton>
            <IconButton label="Dismiss" onClick={onDismiss} disabled={busy}>
              <X />
            </IconButton>
          </span>
        </>
      }
      date={formatShortDate(item.created)}
    />
  );
}

/** The row shows only the dump's first line; the rest is behind the drop-down. */
function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? '';
}

/** How many lines the row is not showing — the "+N more" hint. */
function extraLines(text: string): number {
  return Math.max(
    0,
    text.split('\n').filter((l) => l.trim() !== '').length - 1
  );
}
