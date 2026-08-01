import type { InboxClusterGroup, InboxItem, InboxKind } from '@dispatch/client';
import {
  Bot,
  CircleHelp,
  Combine,
  Inbox,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { EnrichReview } from '../components/tasks/EnrichReview';
import { SectionLabel } from '../components/ui/SectionLabel';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { EnrichDraft } from '../lib/enrichReview';
import { enrichViewState, formatEnrichedInboxText } from '../lib/enrichReview';
import { shouldRecluster } from '../lib/inboxAutoCluster';
import { splitCaptureLines } from '../lib/inboxCapture';
import { describeCluster, findCluster } from '../lib/inboxCluster';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { cn } from '@/lib/utils';

// Anything below this and there is nothing to group — mirrors InboxClusterer's own MIN_ITEMS
// (packages/server/src/inboxClusterer.ts) so the sidebar's "not enough yet" copy and the
// auto-cluster trigger agree on the same threshold.
const CLUSTER_MIN_ITEMS = 3;
// How long to let captures settle before asking the model to group them — long enough that
// someone mid-dump doesn't trigger a call per keystroke-adjacent action, short enough that the
// suggestion still feels like it showed up on its own.
const CLUSTER_DEBOUNCE_MS = 1500;

interface BrainDumpViewProps {
  data: DispatchProjectData;
  onPlanText: (text: string) => void;
  onOpenTask: (taskId: string) => void;
}

// Kind badges take existing palette tokens — a bug is the app's red, an idea its accent. None of
// the mockup's own colours are used anywhere in this screen.
const KIND_SKIN: Record<InboxKind, string> = {
  bug: 'text-state-failed bg-state-failed-surface',
  idea: 'text-state-working bg-state-working-surface',
  task: 'text-state-review bg-state-review-surface',
  note: 'text-muted-foreground bg-muted',
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
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The model-backed grouping runs automatically in the background (see the effect below), so it
  // gets its own state, separate from the free local hint: null until it has run once, [] once
  // run and told there is nothing related. `clusterError` is deliberately not routed through the
  // `error` banner above — a background pass failing must not read as a hard failure.
  const [groups, setGroups] = useState<InboxClusterGroup[] | null>(null);
  const [grouping, setGrouping] = useState(false);
  const [clusterError, setClusterError] = useState<string | null>(null);
  // The open-item id set the last successful (or attempted) cluster call covered — `null` until
  // the first run. Feeds `shouldRecluster` so the effect below only fires on a genuine
  // membership change, never on every render or on a same-items reorder.
  const lastClusteredIdsRef = useRef<string[] | null>(null);
  // Which id set the currently in-flight cluster call was started for. A response is applied
  // only if this still matches what it was fetched for — otherwise the open set moved on while
  // the call was in the air, and the result is stale.
  const inFlightIdsRef = useRef<string[] | null>(null);

  const inbox = data.inbox;
  const open = useMemo(() => inbox.filter((i) => !i.done), [inbox]);
  const sorted = useMemo(() => inbox.filter((i) => i.done), [inbox]);
  const cluster = useMemo(() => findCluster(inbox), [inbox]);
  const openItemIds = useMemo(() => open.map((i) => i.id), [open]);
  const pendingLines = splitCaptureLines(draft).length;

  // The one in-flight/last "Add detail" draft this view can show at a time — mirrors
  // `enrichPlanRecord`'s single-slot shape on the task dialog. `enrichItemId` says which row it
  // belongs to; every other row ignores it.
  const enrichItemId = data.inboxEnrichItemId;
  const enrichState = enrichViewState(data.inboxEnrichPlanRecord);

  // Automatic grouping: debounced ~1.5s after the open-item set genuinely changes (not on every
  // render, not on a mere reorder — see shouldRecluster). No manual trigger needed; the refresh
  // icon in the sidebar exists only to force a retry (e.g. after a failed/timed-out pass).
  // Declared here, above the early return below, because every hook in this component must run
  // on every render regardless of daemon availability — `runCluster` (defined further down) is
  // an ordinary hoisted function declaration, so referencing it here before its textual
  // definition is safe.
  // `runCluster` intentionally excluded from deps — it only reads refs/props, and depending on
  // its (re-created every render) identity would defeat the debounce.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (
      !shouldRecluster(
        openItemIds,
        lastClusteredIdsRef.current,
        CLUSTER_MIN_ITEMS
      )
    ) {
      return;
    }
    const timer = setTimeout(
      () => runCluster(openItemIds),
      CLUSTER_DEBOUNCE_MS
    );
    return () => clearTimeout(timer);
  }, [openItemIds]);

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
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
      }
    });
  }

  // Runs one cluster call for a given open-item id set. Shared by the automatic effect below and
  // the manual refresh icon, so both go through the same staleness guard: if `openItemIds` has
  // moved on by the time the response lands (items captured/dismissed/converted mid-call), the
  // result is discarded rather than overwriting state for a set the user can no longer see.
  function runCluster(ids: string[]): void {
    inFlightIdsRef.current = ids;
    setGrouping(true);
    void (async () => {
      try {
        const { groups: result, error: clusterErr } =
          await data.handleClusterInbox();
        if (inFlightIdsRef.current !== ids) return; // superseded — drop it
        lastClusteredIdsRef.current = ids;
        setClusterError(clusterErr);
        // A failed/timed-out background pass keeps whatever grouping was last shown rather
        // than blanking it out from under the user.
        if (clusterErr === null) setGroups(result);
      } catch (err) {
        if (inFlightIdsRef.current !== ids) return;
        lastClusteredIdsRef.current = ids;
        setClusterError(err instanceof Error ? err.message : String(err));
      } finally {
        if (inFlightIdsRef.current === ids) setGrouping(false);
      }
    })();
  }

  function addDetail(id: string): void {
    void guard(async () => {
      await data.handleEnrichInboxItem(id);
    });
  }

  // Writes the drafted description/criteria back onto the item's `text` and drops the draft.
  function applyEnrichDraft(id: string, enrichDraft: EnrichDraft): void {
    void guard(async () => {
      await data.handleApplyInboxEnrich(
        id,
        formatEnrichedInboxText(enrichDraft)
      );
    });
  }

  function dismiss(ids: string[]): void {
    void guard(async () => {
      await data.handleDismissInbox(ids);
      setSelected(new Set());
    });
  }

  const selectedTexts = () =>
    open.filter((i) => selected.has(i.id)).map((i) => i.text);

  return (
    <div className="flex h-full min-h-0 gap-6">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto">
        <div className="flex items-baseline gap-2">
          <h1 className="view-topbar-title">Brain dump</h1>
          <span className="text-muted-foreground text-[12px]">
            Everything lands here first. Sort it later, or never.
          </span>
        </div>

        <div className="shadow-hairline bg-card rounded-lg p-3.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // ⌘⏎ commits, matching the legend in the rail. Plain Enter has to stay a newline —
              // the whole point is dumping several thoughts at once.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (draft.trim() !== '') capture();
              }
            }}
            placeholder="Dump it here — bugs, half-ideas, things you noticed, one per line…"
            className="text-foreground min-h-[92px] w-full resize-y bg-transparent text-[14px] leading-relaxed outline-none"
          />
          <div className="mt-2.5 flex items-center gap-2.5">
            <span className="dense-meta flex-1">
              {pendingLines > 0
                ? `${pendingLines} ${pendingLines === 1 ? 'line' : 'lines'} — each becomes one item`
                : 'One thought per line. Paste a wall of text and it gets split.'}
            </span>
            <button
              type="button"
              disabled={draft.trim() === '' || busy}
              onClick={() => onPlanText(draft)}
              className="shadow-hairline text-muted-foreground hover:bg-muted/60 hover:text-foreground flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] disabled:opacity-50"
            >
              <Sparkles className="size-3.5" />
              Hand it to the planner
            </button>
            <button
              type="button"
              disabled={draft.trim() === '' || busy}
              onClick={capture}
              className="text-accent-foreground bg-accent hover:bg-accent/80 flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] disabled:opacity-50"
            >
              <Inbox className="size-3.5" />
              Drop into the inbox
            </button>
          </div>
        </div>

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
              onClick={() => onPlanText(selectedTexts().join('. '))}
              disabled={busy}
            >
              Group into an epic
            </BarButton>
            <BarButton onClick={() => dismiss([...selected])} disabled={busy}>
              Dismiss
            </BarButton>
            <BarButton onClick={() => setSelected(new Set())} disabled={busy}>
              Clear
            </BarButton>
          </div>
        )}

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
                    enriching={
                      enrichItemId === it.id && enrichState.kind === 'running'
                    }
                    onToggle={() => toggle(it.id)}
                    onMakeTask={() => convert([it.id])}
                    onAddDetail={() => addDetail(it.id)}
                    onPlan={() => onPlanText(it.text)}
                    onDismiss={() => dismiss([it.id])}
                  />
                  {/* The draft belongs to at most one row at a time — rendered right under it,
                  not in a modal, so applying or dismissing stays in the flow of the list. */}
                  {enrichItemId === it.id && enrichState.kind !== 'idle' && (
                    <li className="px-1 pb-1.5">
                      {enrichState.kind === 'running' && (
                        <p className="text-muted-foreground text-[12.5px]">
                          Reading the repo…
                        </p>
                      )}
                      {enrichState.kind === 'failed' && (
                        <div className="flex items-center gap-2">
                          <span className="text-state-failed text-[12.5px]">
                            {enrichState.error}
                          </span>
                          <BarButton onClick={data.handleDismissInboxEnrich}>
                            Dismiss
                          </BarButton>
                        </div>
                      )}
                      {enrichState.kind === 'ready' && (
                        <EnrichReview
                          draft={enrichState.draft}
                          applying={busy}
                          applyLabel="Apply"
                          discardLabel="Dismiss"
                          note="Applying replaces the captured line above."
                          onApply={() =>
                            applyEnrichDraft(it.id, enrichState.draft)
                          }
                          onDiscard={data.handleDismissInboxEnrich}
                        />
                      )}
                    </li>
                  )}
                </Fragment>
              ))}
            </ul>
          )}
        </section>

        {sorted.length > 0 && (
          <section>
            <button
              type="button"
              onClick={() => setArchiveOpen((v) => !v)}
              className="text-muted-foreground hover:text-foreground text-[12px]"
            >
              {archiveOpen ? 'Hide' : 'Show'} the {sorted.length} already sorted
            </button>
            {archiveOpen && (
              <ul className="mt-1.5 flex flex-col">
                {sorted.map((it) => (
                  <li
                    key={it.id}
                    className="grid grid-cols-[56px_minmax(0,1fr)_90px] items-center gap-3 px-1 py-1"
                  >
                    <span
                      className={cn(
                        'dense-meta rounded px-1.5',
                        KIND_SKIN[it.kind]
                      )}
                    >
                      {it.kind}
                    </span>
                    <span className="text-muted-foreground truncate text-[13px] line-through">
                      {it.text}
                    </span>
                    {it.linkedTaskId === null ? (
                      <span className="dense-meta text-right">dismissed</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onOpenTask(it.linkedTaskId ?? '')}
                        className="dense-meta text-accent-foreground text-right hover:underline"
                      >
                        → {it.linkedTaskId}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>

      <aside className="flex w-64 shrink-0 flex-col gap-5 overflow-y-auto">
        {cluster !== null && (
          <div className="bg-accent/10 shadow-hairline-strong rounded-lg p-3">
            <div className="dense-label text-accent-foreground flex items-center gap-1.5">
              <Combine className="size-3.5" />
              These look like one thing
            </div>
            <p className="text-muted-foreground mt-2 text-[12.5px] leading-relaxed">
              {describeCluster(cluster)}
            </p>
            <button
              type="button"
              onClick={() => setSelected(new Set(cluster.ids))}
              className="text-accent-foreground bg-accent mt-2.5 rounded-md px-2.5 py-1 text-[12px]"
            >
              Select them
            </button>
          </div>
        )}

        <div>
          {/* Two passes, deliberately distinct. The hint above is free and instant but can only
              see shared words; this one asks a model, so it runs automatically in the background
              a moment after the open set changes rather than on every render. The refresh icon
              is the manual escape hatch — automatic must not mean "no way to retry". */}
          <SectionLabel
            trailing={
              <span className="flex items-center gap-1.5">
                {grouping && (
                  <span className="text-muted-foreground text-[11px]">
                    Grouping…
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => runCluster(openItemIds)}
                  disabled={grouping || openItemIds.length < CLUSTER_MIN_ITEMS}
                  aria-label={
                    clusterError !== null
                      ? `Refresh groups (last attempt failed: ${clusterError})`
                      : 'Refresh groups'
                  }
                  title={
                    clusterError !== null
                      ? `Last attempt failed: ${clusterError}`
                      : 'Refresh groups'
                  }
                  className={cn(
                    'rounded p-0.5 disabled:opacity-40',
                    clusterError !== null
                      ? 'text-state-failed'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <RefreshCw
                    className={cn('size-3.5', grouping && 'animate-spin')}
                  />
                </button>
              </span>
            }
          >
            Group into epics
          </SectionLabel>
          {groups === null ? (
            openItemIds.length < CLUSTER_MIN_ITEMS ? (
              <p className="text-muted-foreground mt-2 text-[12.5px] leading-relaxed">
                Capture a few more to enable grouping.
              </p>
            ) : null
          ) : groups.length === 0 ? (
            <p className="text-muted-foreground mt-2 text-[12.5px]">
              Nothing here looks related.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {groups.map((g) => (
                <li
                  key={g.epicTitle}
                  className="shadow-hairline rounded-lg p-2.5"
                >
                  <div className="text-[12.5px] font-medium">{g.epicTitle}</div>
                  <p className="text-muted-foreground mt-1 text-[12px] leading-relaxed">
                    {g.reason}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="dense-meta">{g.itemIds.length} items</span>
                    <span className="flex-1" />
                    <button
                      type="button"
                      onClick={() => setSelected(new Set(g.itemIds))}
                      className="text-accent-foreground text-[11px]"
                    >
                      Select
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const texts = inbox
                          .filter((i) => g.itemIds.includes(i.id))
                          .map((i) => i.text);
                        onPlanText(`${g.epicTitle}. ${texts.join('. ')}`);
                      }}
                      className="text-accent-foreground text-[11px]"
                    >
                      Make an epic
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* The explainer prose (what grouping does, how the inbox works, the key legend) sat
            here permanently before this task — the second half of the user's complaint. It now
            lives behind one footer affordance, revealed on hover and on focus/click so it stays
            keyboard-reachable, instead of occupying space on every visit. */}
        <div className="mt-auto flex justify-center">
          <ExplainerPopover />
        </div>
      </aside>
    </div>
  );
}

// A single "what is this?" affordance that reveals the explainer prose the sidebar used to show
// permanently. Controlled (rather than Radix's default click-to-toggle) so it opens on hover
// too — mouse users never have to click, keyboard users get it for free via focus.
function ExplainerPopover() {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onClick={() => setOpen((v) => !v)}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]"
        >
          <CircleHelp className="size-3.5" />
          What is this?
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="flex flex-col gap-3.5"
      >
        <div>
          <SectionLabel>Group into epics</SectionLabel>
          <p className="text-muted-foreground mt-2 text-[12.5px] leading-relaxed">
            Reads your captures and suggests which ones are really one piece of
            work — automatically, a moment after what you've captured changes.
            Use the refresh icon to force another look.
          </p>
        </div>
        <div>
          <SectionLabel>How this works</SectionLabel>
          <p className="text-muted-foreground mt-2 text-[12.5px] leading-relaxed">
            Nothing here is a commitment. Items sit in the inbox until you make
            them tasks, hand them to the planner, or dismiss them. Everything is
            written to <span className="dense-meta">.dispatch/inbox.md</span> in
            your repo — edit it by hand any time.
          </p>
        </div>
        <div>
          <SectionLabel>Keys</SectionLabel>
          <dl className="mt-2 flex flex-col gap-1.5">
            <Key combo="⌘⏎" what="drop into the inbox" />
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
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="shadow-hairline hover:bg-muted/60 rounded-md px-2 py-1 text-[12px] disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function Key({ combo, what }: { combo: string; what: string }) {
  return (
    <div className="flex items-center gap-2">
      <dt className="dense-meta shadow-hairline rounded px-1.5 py-0.5">
        {combo}
      </dt>
      <dd className="text-muted-foreground text-[12px]">{what}</dd>
    </div>
  );
}

function InboxRow({
  item,
  selected,
  busy,
  enriching,
  onToggle,
  onMakeTask,
  onAddDetail,
  onPlan,
  onDismiss,
}: {
  item: InboxItem;
  selected: boolean;
  busy: boolean;
  /** Whether this row's own "Add detail" draft is currently being drafted — disables and
   * relabels just its button, distinct from `busy` (every button in the view). */
  enriching: boolean;
  onToggle: () => void;
  onMakeTask: () => void;
  onAddDetail: () => void;
  onPlan: () => void;
  onDismiss: () => void;
}) {
  return (
    <li
      className={cn(
        'group grid grid-cols-[20px_56px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-150',
        selected ? 'bg-accent/15 shadow-hairline-strong' : 'hover:bg-muted/40'
      )}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        aria-label={`Select "${item.text}"`}
        className="accent-accent size-3.5"
      />
      <span
        className={cn(
          'dense-meta rounded px-1.5 text-center',
          KIND_SKIN[item.kind]
        )}
      >
        {item.kind}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
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
        {/* Sends this one line to the planner to be turned into a properly specified task —
            the thing a one-liner is missing is context, not wording. */}
        <BarButton onClick={onAddDetail} disabled={busy || enriching}>
          {enriching ? 'Reading the repo…' : 'Add detail'}
        </BarButton>
        <BarButton onClick={onPlan} disabled={busy}>
          Plan it
        </BarButton>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          aria-label="Dismiss"
          className="text-muted-foreground hover:text-state-failed rounded p-1 disabled:opacity-50"
        >
          <X className="size-3.5" />
        </button>
      </span>
    </li>
  );
}
