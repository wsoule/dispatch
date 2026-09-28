// Pure view models for memory surfaces: the memory gate's card, the Inbox's
// undo list, Settings → Memory, and the query keys `memory.changed` refetches.
import type {
  ApiClient,
  LedgerImportReport,
  MemoryActivityRow,
  MemoryEntryView,
  MemoryHealth,
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
  /** A supersede's body now and as proposed, plus the revision it was
   *  proposed against once the entry changed since; null for other actions. */
  diff: { current: string; base: string | null; proposed: string } | null;
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
  const currentBody = (view.current ?? view.base)?.body;
  // A later revision means approving replaces a change the proposal never saw.
  const baseIfChanged =
    view.base !== null &&
    view.current !== null &&
    view.base.rev !== view.current.rev
      ? view.base.body
      : null;
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
      currentBody !== undefined
        ? {
            current: currentBody,
            base: baseIfChanged,
            proposed: proposal.content.body,
          }
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

/** The caller's personal activity as Inbox lines, newest first (the daemon
 *  lists it oldest first). Undo reverts an entry's latest revision, so only
 *  the newest change to each entry offers it; notices never do. */
export function activityItems(
  rows: readonly MemoryActivityRow[]
): MemoryActivityItem[] {
  const seen = new Set<string>();
  return [...rows].reverse().map((row) => {
    const newest = row.memoryId !== null && !seen.has(row.memoryId);
    if (row.memoryId !== null) seen.add(row.memoryId);
    return {
      id: row.id,
      memoryId: row.memoryId,
      text: row.summary,
      at: row.at,
      undoable: newest && UNDOABLE.has(row.kind),
    };
  });
}

/** What Settings → Memory shows about the store and the imports, from the
 *  daemon's health report. */
export interface MemorySettingsModel {
  status: 'ok' | 'unavailable';
  /** One line on the store: what it holds, or why it is closed. */
  store: string;
  /** One per config key that fell back to its default. */
  warnings: string[];
  /** The last ledger import's counts; null before any import. */
  parityText: string | null;
  /** `unknown` for anyone but the daemon's own human, whose notes they are. */
  claudeImport: 'complete' | 'failed' | 'unconfirmed' | 'running' | 'unknown';
  /** The directory the Claude notes were read from, once they were. */
  claudeSource: string | null;
  /** Where the notes may be, while the import is unconfirmed. */
  candidates: string[];
  /** Why the caller's own personal store is closed, when it is. */
  personalUnavailable: string | null;
  /** The caller's pinned entries alone exceed the index budget. */
  pinnedOverflow: boolean;
}

// The import's own orders, so the report reads the same as the CLI's.
const LEDGER_KINDS = ['constraint', 'hazard', 'decision', 'handoff'];
const AUDIT_REASONS = [
  'policy',
  'floor',
  'scope',
  'undeclared-writes',
  'dep-map',
  'handoff',
];

// `n thing` or `n things`.
function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// The parity block: a label padded to 22 columns, its count to 5, then the breakdown.
function parityText(r: LedgerImportReport): string {
  const line = (label: string, count: number, detail = '') => {
    const head = `${label.padEnd(22)}${String(count).padStart(5)}`;
    return detail === '' ? head : `${head}   (${detail})`;
  };
  const breakdown = (keys: readonly string[], counts: Record<string, number>) =>
    keys.map((key) => `${key} ${counts[key] ?? 0}`).join(' · ');
  const m = r.memory;
  return [
    r.outcome === 'MISMATCH'
      ? `outcome: MISMATCH — ${r.mismatches.join('; ')}`
      : `outcome: ${r.outcome}`,
    line('ledger rows read', r.read, breakdown(LEDGER_KINDS, r.byKind)),
    line(
      '→ memory',
      m.total,
      `imported ${m.imported} · proposed ${m.proposed} · truncated ${m.truncated} · already imported ${m.alreadyImported}, of which deleted ${m.alreadyDeleted}`
    ),
    line('→ audit-only', r.audit.total ?? 0, breakdown(AUDIT_REASONS, r.audit)),
    line('damaged', r.damaged),
    `memory rows       ${r.memoryRows.before} → ${r.memoryRows.after}`,
    `open proposals    ${r.openProposals.before} → ${r.openProposals.after}`,
  ].join('\n');
}

/** Settings → Memory's view of the daemon's memory health. */
export function memorySettingsModel(health: MemoryHealth): MemorySettingsModel {
  const search =
    health.search === 'like' ? 'plain search (no FTS5)' : 'full-text search';
  const proposals =
    health.openProposals === 0
      ? 'no open proposals'
      : counted(health.openProposals, 'open proposal', 'open proposals');
  const claude = health.claudeImport;
  return {
    status: health.available ? 'ok' : 'unavailable',
    store: health.available
      ? `${counted(health.entries, 'entry', 'entries')} · ${proposals} · ${search}`
      : `Unavailable: ${health.reason ?? 'memory.db did not open'}`,
    warnings: health.configWarnings.map((w) => w.message),
    parityText:
      health.ledgerImport === null ? null : parityText(health.ledgerImport),
    claudeImport: claude?.state ?? 'unknown',
    claudeSource: claude?.source ?? null,
    candidates: claude?.candidates ?? [],
    personalUnavailable:
      health.personal !== null && !health.personal.available
        ? (health.personal.reason ?? 'personal memory is unavailable')
        : null,
    pinnedOverflow: health.pinnedOverflow,
  };
}

// Where an imported entry came from, by its origin's source prefix.
const ORIGIN_TEXT: Record<string, string> = {
  ledger: 'from the ledger',
  claude: 'from your Claude notes',
  amendment: 'from a task amendment',
};

/** One line on where an entry came from: scope and kind, its source or
 *  author, who approved it, how far it is trusted, and whether it is stale
 *  or pinned. */
export function entryProvenance(entry: MemoryEntryView): string {
  const scope = `${entry.scope.charAt(0).toUpperCase()}${entry.scope.slice(1)}`;
  const source =
    entry.origin === null
      ? undefined
      : ORIGIN_TEXT[entry.origin.slice(0, entry.origin.indexOf(':'))];
  const parts = [`${scope} ${entry.kind}`, source ?? `by ${entry.author}`];
  const approved =
    entry.decidedBy !== null
      ? `approved by ${entry.decidedBy}`
      : entry.decidedByPolicy !== null
        ? `approved by policy at rung ${entry.decidedByPolicy.rung}`
        : null;
  if (approved !== null) parts.push(approved);
  parts.push(
    entry.trust === 'human'
      ? 'human-written'
      : entry.trust === 'confirmed'
        ? 'confirmed'
        : approved === null
          ? 'unreviewed'
          : 'agent-written'
  );
  if (entry.state === 'stale') parts.push('stale');
  if (entry.pinned) parts.push('pinned');
  return parts.join(' · ');
}
