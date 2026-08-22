import type { EventBus, ServerEvent } from './events.js';
import type { FixLoopState } from './orchestrator/fixLoop.js';
import type { QuestionRegistry } from './orchestrator/questions.js';
import type { ScopeRequestRegistry } from './orchestrator/scopeRequests.js';
import type { RunMeta } from './orchestrator/types.js';

// The types below are deliberately not exported: `DecisionItem` and
// `DecisionFeedContext` carry them structurally, so nothing outside this module
// has to name them, and knip's zero-unused-export gate would fail on a name no
// caller uses. Export one the day a caller genuinely needs it.

/**
 * What kind of thing is waiting on a human.
 *
 * - `approval`        a run is parked mid-tool-call on a permission gate.
 * - `scope-request`   an agent asked to edit outside its declared writes.
 * - `question`        an agent called `ask_user` and is blocked on the answer.
 * - `fix-loop-capped` a review/fix loop stopped and wants a written ruling.
 * - `run-stalled`     a run ended or dead-ended and nobody has dealt with it.
 *
 * The first two are the "gates awaiting a decision" pair: they are separate
 * kinds rather than one because they are answered through different routes
 * and carry different payloads, and a surface has to render them differently.
 */
type DecisionKind =
  | 'approval'
  | 'scope-request'
  | 'question'
  | 'fix-loop-capped'
  | 'run-stalled';

/**
 * Whether an item demands an answer before work continues (`blocking`) or is
 * only worth knowing about after the fact (`recorded`).
 *
 * Nothing today produces `recorded` — every kind above is by definition
 * something a human still has to act on. The distinction exists now so the
 * policy engine (epic e-ad1978) can reclassify items through
 * `DecisionFeedContext.policy` and have `list({ disposition })` become its
 * filter, instead of that epic having to reshape this feed's contract.
 */
export type DecisionDisposition = 'blocking' | 'recorded';

/** Why a `run-stalled` item is here — the strongest signal found on the run. */
type StalledRunReason =
  | 'base-discarded'
  | 'interrupted-dirty'
  | 'orphan-commits'
  | 'failed';

/** One thing awaiting a human, as the daemon sees it right now. */
export interface DecisionItem {
  /** `<kind>:<source id>`. Stable across recomputes, so a surface can key rows
   *  on it and a delivery channel can dedupe against what it already sent. */
  id: string;
  kind: DecisionKind;
  /** One line naming what is being asked, for surfaces and delivery channels
   *  that have no room to render the whole item. */
  summary: string;
  /** Which flavour of `kind` this is, when the kind alone is ambiguous: the
   *  fix loop's stop reason, or why a run counts as stalled. */
  reason?: string;
  runId?: string;
  taskId?: string;
  taskTitle?: string;
  /** When this started waiting. */
  since: string;
  /** How long it has been waiting, measured when the snapshot was taken.
   *  Still counted from `since` for a resolved item, so "it sat for an hour"
   *  survives the resolution. */
  ageMs: number;
  state: 'open' | 'resolved';
  /** Set only on `resolved` items: when the feed noticed it had gone. */
  resolvedAt?: string;
  disposition: DecisionDisposition;
}

/** Everything a classifier may look at. Excludes `disposition`, which is the
 *  thing being decided. */
export type UnclassifiedDecisionItem = Omit<DecisionItem, 'disposition'>;

/** The policy-engine seam: decides whether an item blocks or is merely
 *  recorded. */
export type DecisionPolicy = (
  item: UnclassifiedDecisionItem
) => DecisionDisposition;

/**
 * The slice of the orchestrator this feed reads.
 *
 * Narrowed to the two read methods rather than taking `Orchestrator` whole:
 * it documents that the feed only ever observes runs, and it lets a test
 * exercise the aggregation without standing up worktrees and executors.
 * `Orchestrator` satisfies it structurally, so index.ts passes the real one.
 */
interface DecisionFeedRuns {
  list(): RunMeta[];
  pendingApprovals(): {
    runId: string;
    taskId: string;
    taskTitle: string;
    requestId: string;
    toolName: string;
    input: unknown;
  }[];
}

/** The slice of TaskCache this feed reads: a task id to its title. */
interface DecisionFeedTitles {
  get(id: string): { meta: { title: string } } | null;
}

/** The slice of FixLoopStore this feed reads. */
interface DecisionFeedLoops {
  list(): FixLoopState[];
}

export interface DecisionFeedContext {
  orchestrator: DecisionFeedRuns;
  questions: Pick<QuestionRegistry, 'listOpen'>;
  scopeRequests: Pick<ScopeRequestRegistry, 'listOpen'>;
  fixLoopStore: DecisionFeedLoops;
  cache: DecisionFeedTitles;
  events: Pick<EventBus, 'subscribe' | 'broadcast'>;
  /** Defaults to "everything here blocks" — see DecisionDisposition. */
  policy?: DecisionPolicy;
  /** Test seam. Defaults to `Date.now`. */
  now?: () => number;
}

export interface DecisionFeedListOptions {
  disposition?: DecisionDisposition;
  /** Resolved items are dropped unless this is true. */
  includeResolved?: boolean;
}

/**
 * How long a resolved item stays visible after the feed notices it is gone.
 *
 * Without a window an item answered on another surface would vanish out from
 * under whoever was reading it, with no trace of what happened to it. Short,
 * because the feed is "what needs a human now", not a history — the ledger and
 * the transcripts are the durable record.
 */
const RESOLVED_RETENTION_MS = 5 * 60_000;

/** Hard cap on retained resolutions, so a burst cannot grow the feed without
 *  bound before the time window catches up with it. Oldest go first. */
const MAX_RESOLVED = 50;

/** Source events that can change what is awaiting a human. Deliberately not
 *  `run.log`: it fires per streamed entry and never moves a run in or out of
 *  this feed. */
const TRIGGER_EVENTS: ReadonlySet<ServerEvent['type']> = new Set([
  'approval.requested',
  'run.changed',
  'run.survey',
  'question.asked',
  'question.answered',
  'question.closed',
  'scope.requested',
  'scope.decided',
  'fixloop.changed',
  'fixloop.capped',
]);

// Every kind in this feed is something a human still has to answer, so the
// out-of-the-box policy says so rather than inventing a split no producer
// currently expresses. See DecisionDisposition.
const blockingPolicy: DecisionPolicy = () => 'blocking';

// Truncates free text to one short line, so a summary stays a summary even
// when the agent's reason or question ran to paragraphs.
function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

// Why this run needs a human, or null when it does not. Order matters: a
// discarded base outranks how the run itself ended, because it is the one
// state no automatic path can repair (see RunMeta.baseDiscarded).
function stalledReason(run: RunMeta): StalledRunReason | null {
  if (run.archivedAt !== undefined || run.reviewedAt !== undefined) return null;
  if (run.baseDiscarded === true) return 'base-discarded';
  if (run.state === 'interrupted-dirty') return 'interrupted-dirty';
  if (run.state !== 'failed') return null;
  if ((run.survey?.postFailCommits?.length ?? 0) > 0) return 'orphan-commits';
  return 'failed';
}

const STALLED_SUMMARY: Record<StalledRunReason, string> = {
  'base-discarded': 'run cannot be restacked — its base is gone',
  'interrupted-dirty': 'run was interrupted with uncommitted work left behind',
  'orphan-commits': 'run failed but its agent kept committing',
  failed: 'run failed and has not been reviewed',
};

/**
 * The daemon's one feed of everything awaiting a human.
 *
 * Derived, never stored: every call recomputes from the live registries, so an
 * item resolves the moment the underlying gate is decided or the run moves on,
 * with no invalidation to get wrong. The only state kept here is the set of
 * items last seen open, which is what lets a resolution be reported once
 * (`state: 'resolved'`) instead of a row silently disappearing.
 */
export class DecisionFeed {
  private readonly policy: DecisionPolicy;
  private readonly now: () => number;
  // Open items as of the last recompute, keyed by id — the "was it here
  // before?" side of resolution detection.
  private lastOpen = new Map<string, UnclassifiedDecisionItem>();
  // Items that were open and are not any more, insertion-ordered so pruning
  // the oldest is a walk from the front.
  private readonly resolved = new Map<string, UnclassifiedDecisionItem>();
  // What the feed contains as of the last recompute — refreshed by every read.
  private signature = '';
  // What subscribers were last told the feed contains. Deliberately separate
  // from `signature`: every read recomputes, so sharing one cursor let a
  // client's poll land between a source write and the event it triggers, move
  // the baseline forward, and leave the event comparing the new state against
  // itself — swallowing the broadcast for every other client.
  private broadcastSignature = '';

  constructor(private readonly ctx: DecisionFeedContext) {
    this.policy = ctx.policy ?? blockingPolicy;
    this.now = ctx.now ?? Date.now;
  }

  /**
   * Starts broadcasting `decisions.changed` when the feed's contents change.
   *
   * Rides `EventBus.subscribe` rather than a call at each producer: the four
   * sources already announce themselves (a question is asked, a scope request
   * is decided, a run changes state), so this needs to translate those into
   * one feed-level event, not to be threaded through the orchestrator.
   *
   * Returns its own unsubscribe, matching the EventBus contract.
   */
  start(): () => void {
    // Seeds `signature` and `lastOpen`, so the first real event compares
    // against what the daemon booted with instead of against nothing and
    // reporting a change that never happened.
    this.recompute();
    this.broadcastSignature = this.signature;
    return this.ctx.events.subscribe((event) => {
      if (!TRIGGER_EVENTS.has(event.type)) return;
      this.recompute();
      if (this.signature === this.broadcastSignature) return;
      this.broadcastSignature = this.signature;
      this.ctx.events.broadcast({ type: 'decisions.changed' });
    });
  }

  /**
   * Everything awaiting a human right now, newest-waiting last.
   *
   * Open items come first, longest-waiting first — age is the escalation
   * signal, so the thing that has been ignored longest leads. Recently
   * resolved items (when asked for) follow, most recently resolved first.
   */
  list(opts: DecisionFeedListOptions = {}): DecisionItem[] {
    const { open, resolved } = this.recompute();
    const items = opts.includeResolved === true ? [...open, ...resolved] : open;
    const classified = items.map((item) => ({
      ...item,
      disposition: this.policy(item),
    }));
    if (opts.disposition === undefined) return classified;
    return classified.filter((item) => item.disposition === opts.disposition);
  }

  /** How many open items match — what a badge renders without paying for the
   *  whole list. */
  count(disposition?: DecisionDisposition): number {
    return this.list({ disposition }).length;
  }

  // Rebuilds the open set, moves anything that disappeared into `resolved`,
  // prunes stale resolutions, and refreshes the change signature. Every public
  // read goes through here, which is why a plain GET is enough to notice a
  // resolution even if no event fired.
  private recompute(): {
    open: UnclassifiedDecisionItem[];
    resolved: UnclassifiedDecisionItem[];
  } {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    // One pass over the run list per recompute rather than a lookup per item:
    // three of the five builders need to resolve a runId to its task, and the
    // registry list is rebuilt on every call.
    const runs = new Map(
      this.ctx.orchestrator.list().map((run) => [run.id, run])
    );
    const open = [
      ...this.approvalItems(nowMs, runs),
      ...this.scopeRequestItems(nowMs, runs),
      ...this.questionItems(nowMs, runs),
      ...this.fixLoopItems(nowMs),
      ...this.stalledRunItems(nowMs, runs),
    ].sort((a, b) => a.since.localeCompare(b.since));

    const openById = new Map(open.map((item) => [item.id, item]));
    // Anything open last time and absent now was decided, or its run moved on.
    // Reporting it `resolved` once, rather than letting the row vanish, is what
    // stops an item answered on another surface from disappearing mid-read.
    for (const [id, previous] of this.lastOpen) {
      if (openById.has(id)) continue;
      this.resolved.set(id, {
        ...previous,
        ageMs: Math.max(0, nowMs - Date.parse(previous.since)),
        state: 'resolved',
        resolvedAt: nowIso,
      });
    }
    // An id can come back — a fix loop can be adjudicated and then cap again
    // on the same task — and a re-opened item must not also read as resolved.
    for (const id of openById.keys()) this.resolved.delete(id);
    this.pruneResolved(nowMs);
    this.lastOpen = openById;

    const resolved = [...this.resolved.values()].reverse();
    // Keyed on what a surface actually renders, minus anything time-derived.
    // `reason` and `summary` are in it because an item can change materially
    // without its id or state moving — an orphaned agent that kept committing
    // escalates a stalled run from 'failed' to 'orphan-commits' in place, which
    // is what run.survey is a trigger event for. `since` and `ageMs` are kept
    // out: age moves on every recompute, and an approval whose run has gone
    // falls back to `now`, so folding either in would broadcast on a loop.
    this.signature = [...open, ...resolved]
      .map(
        (item) =>
          `${item.id}:${item.state}:${item.reason ?? ''}:${item.summary}`
      )
      .join('|');
    return { open, resolved };
  }

  private pruneResolved(nowMs: number): void {
    for (const [id, item] of this.resolved) {
      const expired =
        item.resolvedAt !== undefined &&
        nowMs - Date.parse(item.resolvedAt) > RESOLVED_RETENTION_MS;
      if (expired) this.resolved.delete(id);
    }
    while (this.resolved.size > MAX_RESOLVED) {
      const oldest = this.resolved.keys().next();
      if (oldest.done === true) break;
      this.resolved.delete(oldest.value);
    }
  }

  private taskTitle(taskId: string): string | undefined {
    return this.ctx.cache.get(taskId)?.meta.title;
  }

  private approvalItems(
    nowMs: number,
    runs: Map<string, RunMeta>
  ): UnclassifiedDecisionItem[] {
    return this.ctx.orchestrator.pendingApprovals().map((approval) => {
      // The registry records no timestamp per approval request, and the run's
      // `updatedAt` moved when it entered `awaiting-approval` — which is
      // exactly when this started waiting.
      const since =
        runs.get(approval.runId)?.updatedAt ?? new Date(nowMs).toISOString();
      return {
        id: `approval:${approval.requestId}`,
        kind: 'approval' as const,
        summary: `${approval.taskTitle}: agent is waiting for permission to use ${approval.toolName}`,
        runId: approval.runId,
        taskId: approval.taskId,
        taskTitle: approval.taskTitle,
        since,
        ageMs: Math.max(0, nowMs - Date.parse(since)),
        state: 'open' as const,
      };
    });
  }

  private scopeRequestItems(
    nowMs: number,
    runs: Map<string, RunMeta>
  ): UnclassifiedDecisionItem[] {
    return this.ctx.scopeRequests.listOpen().map((request) => {
      const run = runs.get(request.runId);
      const paths =
        request.paths.length > 3
          ? `${request.paths.slice(0, 3).join(', ')} +${request.paths.length - 3} more`
          : request.paths.join(', ');
      return {
        id: `scope-request:${request.id}`,
        kind: 'scope-request' as const,
        summary: `agent asked to edit outside its scope: ${paths}`,
        reason: oneLine(request.reason),
        runId: request.runId,
        taskId: run?.taskId,
        taskTitle: run?.taskTitle,
        since: request.requestedAt,
        ageMs: Math.max(0, nowMs - Date.parse(request.requestedAt)),
        state: 'open' as const,
      };
    });
  }

  private questionItems(
    nowMs: number,
    runs: Map<string, RunMeta>
  ): UnclassifiedDecisionItem[] {
    return this.ctx.questions.listOpen().map((question) => {
      const run = runs.get(question.runId);
      return {
        id: `question:${question.id}`,
        kind: 'question' as const,
        summary: oneLine(question.question),
        runId: question.runId,
        taskId: run?.taskId,
        taskTitle: run?.taskTitle,
        since: question.askedAt,
        ageMs: Math.max(0, nowMs - Date.parse(question.askedAt)),
        state: 'open' as const,
      };
    });
  }

  private fixLoopItems(nowMs: number): UnclassifiedDecisionItem[] {
    return this.ctx.fixLoopStore
      .list()
      .filter((state) => state.state === 'capped')
      .map((state) => {
        const title = this.taskTitle(state.taskId);
        return {
          id: `fix-loop-capped:${state.taskId}`,
          kind: 'fix-loop-capped' as const,
          summary: `${title ?? state.taskId}: fix loop stopped at round ${state.round} of ${state.cap} and needs a ruling`,
          reason: state.stopReason,
          taskId: state.taskId,
          taskTitle: title,
          since: state.updatedAt,
          ageMs: Math.max(0, nowMs - Date.parse(state.updatedAt)),
          state: 'open' as const,
        };
      });
  }

  private stalledRunItems(
    nowMs: number,
    runs: Map<string, RunMeta>
  ): UnclassifiedDecisionItem[] {
    const items: UnclassifiedDecisionItem[] = [];
    for (const run of runs.values()) {
      const reason = stalledReason(run);
      if (reason === null) continue;
      items.push({
        id: `run-stalled:${run.id}`,
        kind: 'run-stalled',
        summary: `${run.taskTitle}: ${STALLED_SUMMARY[reason]}`,
        reason,
        runId: run.id,
        taskId: run.taskId,
        taskTitle: run.taskTitle,
        since: run.updatedAt,
        ageMs: Math.max(0, nowMs - Date.parse(run.updatedAt)),
        state: 'open',
      });
    }
    return items;
  }
}
