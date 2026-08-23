import type { InboxItem, InboxKind } from '@dispatch/client';
import { Bot, CircleHelp, Inbox, RefreshCw, Sparkles, X } from 'lucide-react';
import { Fragment, useMemo, useRef, useState } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { useToasts } from '../components/shell/Toasts';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import {
  BRAIN_DUMP_DRAFT_KEY,
  usePersistedDraft,
} from '../hooks/usePersistedDraft';
import { splitCaptureLines } from '../lib/inboxCapture';
import { buildMilestonePrompt } from '../lib/milestonePrompt';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Panel } from '@/ui/chrome';
import { SectionLabel } from '@/ui/chrome/SectionLabel';
import { Kbd } from '@/ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Textarea } from '@/ui/textarea';

const CLUSTER_MIN_ITEMS = 3;

interface BrainDumpViewProps {
  data: DispatchProjectData;
  onPlanText: (text: string) => void;
  onOpenTask: (taskId: string) => void;
}

// Only the kinds that carry information get a badge — a bug is the app's red, an idea its
// accent. 'task' and 'note' are the unremarkable default and render nothing: a rail of
// same-toned chips said nothing worth 56px a row.
const KIND_SKIN: Partial<Record<InboxKind, string>> = {
  bug: 'text-state-failed bg-state-failed-surface',
  idea: 'text-state-working bg-state-working-surface',
};

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
}: BrainDumpViewProps) {
  const toasts = useToasts();
  // Shared with the ⌘B quick-capture modal and persisted across navigation and
  // relaunch — leaving this screen must not cost half-typed thoughts.
  const [draft, setDraft] = usePersistedDraft(BRAIN_DUMP_DRAFT_KEY);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // The last row whose checkbox was plainly clicked — the anchor a shift-click
  // extends from, file-manager style.
  const [anchorId, setAnchorId] = useState<string | null>(null);
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
  const pendingLines = splitCaptureLines(draft).length;

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
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
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
            label: 'Open',
            onClick: () => onOpenTask(firstTask),
          },
        });
      } else if (res.converted > 1) {
        toasts.push({
          tone: 'success',
          title: `${res.converted} tasks created`,
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

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col gap-4 overflow-y-auto">
      <div className="flex items-baseline gap-2">
        <h1 className="view-topbar-title">Brain dump</h1>
        <span className="text-muted-foreground text-[12px]">
          Everything lands here first. Sort it later, or never.
        </span>
        <span className="flex-1" />
        <ExplainerPopover />
      </div>

      <Panel className="p-3.5">
        {/* `field-sizing-fixed` cancels the primitive's `field-sizing-content`: this box
            stays a draggable 92px rather than growing with what you type. */}
        <Textarea
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
          className="text-foreground field-sizing-fixed min-h-[92px] resize-y border-0 bg-transparent p-0 text-[14px] leading-relaxed shadow-none focus-visible:ring-0 md:text-[14px] dark:bg-transparent"
        />
        <div className="mt-2.5 flex items-center gap-2.5">
          <span className="dense-meta flex-1">
            {pendingLines > 0
              ? `${pendingLines} ${pendingLines === 1 ? 'line' : 'lines'}, one item each`
              : 'One per line. Walls of text get split. Drafts keep.'}
          </span>
          {/* Both carry `has-[>svg]:px-2.5` alongside `px-2.5`: their icon makes the xs
              size's own `has-[>svg]:px-1.5` match, which out-ranks a plain `px-*`. */}
          <Button
            variant="ghost"
            size="xs"
            disabled={draft.trim() === '' || busy}
            onClick={() => onPlanText(draft)}
            className="shadow-hairline text-muted-foreground hover:bg-muted/60 hover:text-foreground h-auto gap-1.5 px-2.5 py-1 text-[12.5px] font-normal has-[>svg]:px-2.5"
          >
            <Sparkles className="size-3.5" />
            Plan
          </Button>
          <Button
            size="xs"
            disabled={draft.trim() === '' || busy}
            onClick={capture}
            className="text-accent-foreground bg-accent hover:bg-accent/80 h-auto gap-1.5 px-2.5 py-1 text-[12.5px] font-normal has-[>svg]:px-2.5"
          >
            <Inbox className="size-3.5" />
            Drop into the inbox
          </Button>
        </div>
      </Panel>

      {error !== null && (
        <p className="text-state-failed text-[12.5px]">{error}</p>
      )}

      {selected.size > 0 && (
        <div className="bg-accent/15 shadow-hairline-strong flex items-center gap-2 rounded-lg px-3 py-2">
          <span className="text-[12.5px]">{selected.size} selected</span>
          <span className="flex-1" />
          <BarButton onClick={() => convert([...selected])} disabled={busy}>
            Make tasks
          </BarButton>
          <BarButton
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
          </BarButton>
          <BarButton onClick={() => dismiss([...selected])} disabled={busy}>
            Dismiss
          </BarButton>
          <BarButton onClick={() => setSelected(new Set())} disabled={busy}>
            Clear
          </BarButton>
        </div>
      )}

      {/* Sits above the inbox list on purpose: the structural hint should land before the raw
          items, so grouping is the first thing considered rather than an afterthought. */}
      <section>
        <SectionLabel
          rule
          trailing={
            <span className="flex items-center gap-2">
              {groupsStale && !grouping && (
                <span className="text-muted-foreground text-[11px]">
                  The list changed since this grouping.
                </span>
              )}
              {clusterError !== null && (
                <span
                  className="text-state-failed max-w-64 truncate text-[11px]"
                  title={clusterError}
                >
                  {clusterError}
                </span>
              )}
              <Button
                variant="ghost"
                size="xs"
                onClick={runCluster}
                disabled={grouping || openItemIds.length < CLUSTER_MIN_ITEMS}
                className="shadow-hairline text-muted-foreground hover:bg-muted/60 hover:text-foreground h-auto gap-1.5 px-2 py-0.5 text-[11.5px] font-normal has-[>svg]:px-2"
              >
                <RefreshCw
                  className={cn('size-3', grouping && 'animate-spin')}
                />
                {grouping ? 'Grouping…' : 'Group'}
              </Button>
            </span>
          }
        >
          Group into milestones
        </SectionLabel>
        {groups === null || groups.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-[12.5px] leading-relaxed">
            {openItemIds.length < CLUSTER_MIN_ITEMS
              ? 'Capture a few more to enable grouping.'
              : groups === null
                ? 'Group asks a model which captures are one piece of work.'
                : 'Nothing here looks related.'}
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {groups.map((g) => (
              <li key={g.epicTitle}>
                <Panel className="shadow-hairline border-transparent bg-transparent p-2.5">
                  <div className="text-[12.5px] font-medium">{g.epicTitle}</div>
                  <p className="text-muted-foreground mt-1 text-[12px] leading-relaxed">
                    {g.reason}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="dense-meta">{g.itemIds.length} items</span>
                    <span className="flex-1" />
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setSelected(new Set(g.itemIds))}
                      className="text-accent-foreground h-auto px-0 text-[11px] font-normal hover:bg-transparent"
                    >
                      Select
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
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
                      className="text-accent-foreground h-auto px-0 text-[11px] font-normal hover:bg-transparent"
                    >
                      Plan as milestone
                    </Button>
                  </div>
                </Panel>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionLabel rule count={open.length}>
          Inbox
        </SectionLabel>
        {open.length === 0 ? (
          <p className="text-muted-foreground py-4 text-[12.5px]">
            Nothing captured yet. Type above — it costs nothing.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {open.map((it) => (
              <Fragment key={it.id}>
                <InboxRow
                  item={it}
                  selected={selected.has(it.id)}
                  busy={busy}
                  editing={editing?.id === it.id}
                  onToggle={(shiftKey) => toggle(it.id, shiftKey)}
                  onMakeTask={() => convert([it.id])}
                  onAddDetail={() => addDetail(it)}
                  onPlan={() => onPlanText(it.text)}
                  onDismiss={() => dismiss([it.id])}
                />
                {/* The editor belongs to at most one row at a time — rendered right under it,
                not in a modal, so saving or cancelling stays in the flow of the list. */}
                {editing?.id === it.id && (
                  <li className="px-1 pb-1.5">
                    <Panel className="p-2.5">
                      <Textarea
                        value={editing.text}
                        autoFocus
                        aria-label={`Edit "${it.text}"`}
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
                        className="text-foreground min-h-[72px] resize-y border-0 bg-transparent p-0 text-[13.5px] leading-relaxed shadow-none focus-visible:ring-0 md:text-[13.5px] dark:bg-transparent"
                      />
                      <div className="mt-2 flex items-center gap-2">
                        <span className="dense-meta flex-1">
                          Saved straight onto the captured line.
                        </span>
                        <BarButton
                          onClick={saveDetail}
                          disabled={busy || editing.text.trim() === ''}
                        >
                          Save
                        </BarButton>
                        <BarButton
                          onClick={() => setEditing(null)}
                          disabled={busy}
                        >
                          Cancel
                        </BarButton>
                      </div>
                    </Panel>
                  </li>
                )}
              </Fragment>
            ))}
          </ul>
        )}
      </section>

      {sorted.length > 0 && (
        <section>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setArchiveOpen((v) => !v)}
            className="text-muted-foreground hover:text-foreground h-auto px-0 text-[12px] font-normal hover:bg-transparent"
          >
            {archiveOpen ? 'Hide' : 'Show'} the {sorted.length} already sorted
          </Button>
          {archiveOpen && (
            <ul className="mt-1.5 flex flex-col">
              {sorted.map((it) => (
                <li
                  key={it.id}
                  className="grid grid-cols-[minmax(0,1fr)_90px] items-center gap-3 px-1 py-1"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    {KIND_SKIN[it.kind] !== undefined && (
                      <span
                        className={cn(
                          'dense-meta shrink-0 rounded px-1.5',
                          KIND_SKIN[it.kind]
                        )}
                      >
                        {it.kind}
                      </span>
                    )}
                    <span className="text-muted-foreground truncate text-[13px] line-through">
                      {it.text}
                    </span>
                  </span>
                  {it.linkedTaskId === null ? (
                    <span className="dense-meta text-right">dismissed</span>
                  ) : (
                    <Button
                      variant="link"
                      size="xs"
                      onClick={() => onOpenTask(it.linkedTaskId ?? '')}
                      className="dense-meta text-accent-foreground h-auto justify-end px-0 text-right text-[length:var(--text-meta)] font-normal"
                    >
                      → {it.linkedTaskId}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

// Reveals the explainer prose on hover, click, or keyboard focus — controlled state, since
// Radix's Popover only opens on click by default. Escape or a click outside dismisses it.
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
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          size="xs"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={closeUnlessTriggerFocused}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          // Suppresses Radix's own click-to-toggle, which would close a popover that
          // hovering or focusing the button has already opened.
          onClick={(e) => e.preventDefault()}
          // `has-[>svg]:px-2` too — the icon makes the size's own `has-[>svg]:px-1.5` match.
          className="text-muted-foreground hover:text-foreground h-auto gap-1.5 px-2 py-1 text-[11px] font-normal hover:bg-transparent has-[>svg]:px-2"
        >
          <CircleHelp className="size-3.5" />
          What is this?
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        // Radix would focus the content on open, blurring the trigger and closing this
        // straight back up; keeping focus on the trigger is what makes Tab reveal it.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={closeUnlessTriggerFocused}
        className="flex flex-col gap-3.5"
      >
        <div>
          <SectionLabel>Group into milestones</SectionLabel>
          <p className="text-muted-foreground mt-2 text-[12.5px] leading-relaxed">
            Group asks a model which of your captures are really one piece of
            work. It runs only when you press it, and the last answer sticks
            around between visits.
          </p>
        </div>
        <div>
          <SectionLabel>How this works</SectionLabel>
          <p className="text-muted-foreground mt-2 text-[12.5px] leading-relaxed">
            Nothing here is a commitment. Items sit in the inbox until you make
            them tasks, hand them to the planner, or dismiss them. Everything is
            written to your own file under{' '}
            <span className="dense-meta">.dispatch/inbox/</span> in your repo —
            edit it by hand any time.
          </p>
        </div>
        <div>
          <SectionLabel>Keyboard</SectionLabel>
          <dl className="mt-2 flex flex-col gap-1.5">
            <Key combo="⌘⏎" what="drop into the inbox" />
            <Key combo="⇧-click" what="select a range of items" />
          </dl>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function BarButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={onClick}
      disabled={disabled}
      className="shadow-hairline hover:bg-muted/60 h-auto px-2 py-1 text-[12px] font-normal"
    >
      {children}
    </Button>
  );
}

function Key({ combo, what }: { combo: string; what: string }) {
  return (
    <div className="flex items-center gap-2">
      <dt className="dense-meta shadow-hairline rounded px-1.5 py-0.5">
        <Kbd className="h-auto min-w-0 bg-transparent px-0 font-mono text-[length:inherit] font-normal text-inherit">
          {combo}
        </Kbd>
      </dt>
      <dd className="text-muted-foreground text-[12px]">{what}</dd>
    </div>
  );
}

function InboxRow({
  item,
  selected,
  busy,
  editing,
  onToggle,
  onMakeTask,
  onAddDetail,
  onPlan,
  onDismiss,
}: {
  item: InboxItem;
  selected: boolean;
  busy: boolean;
  /** Whether this row's own inline editor is open — disables just its "Add detail" button,
   * distinct from `busy` (every button in the view). */
  editing: boolean;
  /** `shiftKey` extends the selection from the last plainly-clicked row. */
  onToggle: (shiftKey: boolean) => void;
  onMakeTask: () => void;
  onAddDetail: () => void;
  onPlan: () => void;
  onDismiss: () => void;
}) {
  return (
    <li
      className={cn(
        'group grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-150',
        selected ? 'bg-accent/15 shadow-hairline-strong' : 'hover:bg-muted/40'
      )}
    >
      {/* `onClick` rather than `onCheckedChange`: the change callback never sees the
          pointer event, and shift-to-extend needs `shiftKey`. Radix still fires a click
          for keyboard activation, so Space/Enter keep working (with shiftKey false). */}
      <Checkbox
        checked={selected}
        onClick={(e) => onToggle(e.shiftKey)}
        aria-label={`Select "${item.text}"`}
        className="size-3.5"
      />
      <span className="flex min-w-0 items-center gap-1.5">
        {KIND_SKIN[item.kind] !== undefined && (
          <span
            className={cn(
              'dense-meta shrink-0 rounded px-1.5',
              KIND_SKIN[item.kind]
            )}
          >
            {item.kind}
          </span>
        )}
        <span className="truncate text-[13.5px]">{item.text}</span>
        {/* Items an agent flagged mid-run are marked, so you can tell what you noticed
            yourself from what something else noticed for you. */}
        {item.createdByRunId !== null && (
          <span
            className="shrink-0"
            title={`Flagged by ${item.createdByRunId}`}
            aria-label={`Flagged by agent run ${item.createdByRunId}`}
          >
            <Bot className="text-muted-foreground size-3.5" />
          </span>
        )}
      </span>
      <span className="flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
        <BarButton onClick={onMakeTask} disabled={busy}>
          Make a task
        </BarButton>
        {/* Opens the line for editing in place — the thing a one-liner is usually missing is
            detail its author already has in their head. */}
        <BarButton onClick={onAddDetail} disabled={busy || editing}>
          Add detail
        </BarButton>
        <BarButton onClick={onPlan} disabled={busy}>
          Plan
        </BarButton>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onDismiss}
          disabled={busy}
          aria-label="Dismiss"
          className="text-muted-foreground hover:text-state-failed size-auto rounded p-1 hover:bg-transparent"
        >
          <X className="size-3.5" />
        </Button>
      </span>
    </li>
  );
}
