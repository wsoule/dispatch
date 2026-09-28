// Pure view models for memory surfaces: the memory gate's card, the Inbox's
// undo list, and the query keys a `memory.changed` event refetches.
import type {
  ApiClient,
  MemoryActivityRow,
  MemoryEntryView,
  MemoryProposalView,
} from '@dispatch/client';

/** The prefix every memory query of one daemon shares; `memory.changed` invalidates it. */
export function memoryQueryRootKey(
  port: number | undefined
): readonly unknown[] {
  return ['dispatch-memory', port];
}

/** One memory query's key, e.g. `activity` or `health`, under the daemon's root. */
export function memoryQueryKey(
  port: number | undefined,
  part: string
): readonly unknown[] {
  return [...memoryQueryRootKey(port), part];
}

/** A proposal with its target as proposed against (`base`) and as it is now. */
export type ProposalRead = Awaited<ReturnType<ApiClient['getMemoryProposal']>>;

export interface ProposalCardModel {
  action: MemoryProposalView['action'];
  /** The card's question, e.g. "Save this hazard to team memory?". */
  ask: string;
  title: string;
  kind: string;
  scope: string;
  /** Which runs the entry would reach, in the index's terms. */
  reach: string;
  body: string;
  author: string;
  sourceTask: string | null;
  /** A supersede's body now and as proposed; null for any other action. */
  diff: { base: string; proposed: string } | null;
  /** The proposal matches a personal entry of the author's operator. */
  matchedPersonal: boolean;
  /** Author-written text: why to retire, or what a late ledger row claims. */
  note: string | null;
  /** How a proposal that no longer waits was decided; null while open. */
  decided: string | null;
}

// Narrowest first: named tasks, an epic, this machine for project scope,
// else every run here and on teammates' machines.
function reachOf(
  scope: string,
  epic: string | null,
  appliesTo: readonly string[]
): string {
  if (appliesTo.length > 0) return `these tasks: ${appliesTo.join(', ')}`;
  if (epic !== null) return `epic ${epic}`;
  if (scope === 'project') return 'this machine only';
  return 'every run in this project, and teammates’';
}

/** What a memory gate's card shows: the proposed entry, or for a retire the
 *  entry it would retire, never the personal entry it may match. */
export function proposalCardModel(view: ProposalRead): ProposalCardModel {
  const { proposal } = view;
  const target: MemoryEntryView | null = view.current ?? view.base;
  const shown = proposal.content ?? target;
  const kind = shown?.kind ?? 'fact';
  const ask =
    proposal.action === 'add'
      ? `Save this ${kind} to ${proposal.scope} memory?`
      : proposal.action === 'supersede'
        ? `Replace a ${proposal.scope} ${kind} with this version?`
        : `Retire this ${proposal.scope} ${kind}?`;
  const baseBody = (view.base ?? view.current)?.body;
  return {
    action: proposal.action,
    ask,
    title: shown?.title ?? proposal.target ?? 'an entry that no longer exists',
    kind,
    scope: proposal.scope,
    reach: reachOf(proposal.scope, shown?.epic ?? null, shown?.appliesTo ?? []),
    body: shown?.body ?? '',
    author: proposal.author,
    sourceTask: proposal.taskId,
    diff:
      proposal.action === 'supersede' &&
      proposal.content !== null &&
      baseBody !== undefined
        ? { base: baseBody, proposed: proposal.content.body }
        : null,
    matchedPersonal: proposal.matchedPersonal,
    note: proposal.reason,
    decided: proposal.state === 'open' ? null : proposal.state,
  };
}

/** One line of the Inbox's "Your memory" list. */
export interface MemoryActivityItem {
  id: string;
  memoryId: string | null;
  /** The daemon's own summary; titles in it are already made one-line. */
  text: string;
  at: string;
  undoable: boolean;
}

// Kinds that changed an entry, so undo restores its previous revision.
const UNDOABLE: ReadonlySet<MemoryActivityRow['kind']> = new Set([
  'saved',
  'edited',
  'retired',
  'ingested',
]);

/** The caller's personal activity as Inbox lines, in the daemon's order
 *  (newest first); notices such as a hit rate limit have no Undo. */
export function activityItems(
  rows: readonly MemoryActivityRow[]
): MemoryActivityItem[] {
  return rows.map((row) => ({
    id: row.id,
    memoryId: row.memoryId,
    text: row.summary,
    at: row.at,
    undoable: row.memoryId !== null && UNDOABLE.has(row.kind),
  }));
}
