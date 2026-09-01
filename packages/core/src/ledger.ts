// Pure data shapes, no node:* imports, so this is safe for the desktop
// webview via the '@dispatch/core/browser' entry point.

export type LedgerKind = 'constraint' | 'hazard' | 'decision' | 'handoff';

export interface LedgerEntry {
  id: string; // 'l-' + 6 hex
  epicId: string | null; // null = project-wide
  sourceTaskId: string | null;
  kind: LedgerKind;
  title: string;
  detail: string;
  /** Task ids this applies to; empty means every task under the epic. */
  appliesTo: string[];
  createdAt: string;
  /** Serialized ActorRef of whoever wrote it; empty for pre-team records. */
  authoredBy: string;
}

// The write surface every ledger backend takes — see the note on
// AddFindingInput in findings.ts. A decision is a ledger entry with
// `kind: 'decision'`, not a record of its own.

export interface AddLedgerInput {
  epicId?: string | null;
  sourceTaskId?: string | null;
  kind: LedgerKind;
  title: string;
  detail: string;
  appliesTo?: string[];
  /** Serialized ActorRef of whoever wrote it. */
  authoredBy: string;
}

export interface LedgerListFilter {
  epicId?: string | null;
}

// Runtime counterpart of LedgerKind — see the note on FINDING_SEVERITIES.
export const LEDGER_KINDS: readonly LedgerKind[] = [
  'constraint',
  'hazard',
  'decision',
  'handoff',
];
