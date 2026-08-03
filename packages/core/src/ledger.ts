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
