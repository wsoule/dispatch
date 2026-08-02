// Pure data shapes, no node:* imports, so this is safe for the desktop
// webview via the '@dispatch/core/browser' entry point.

export type FindingSeverity = 'critical' | 'important' | 'minor';
export type FindingVerdict = 'open' | 'addressed' | 'parked' | 'blocked';

export interface Finding {
  id: string; // 'f-' + 6 hex
  taskId: string;
  runId: string | null; // the review run that raised it
  severity: FindingSeverity;
  verdict: FindingVerdict;
  title: string;
  detail: string;
  file: string | null;
  line: number | null;
  /** Set when parked or blocked — why, in the controller's words. */
  ruling: string | null;
  round: number; // fix round that raised it, 0 for the first review
  createdAt: string;
  updatedAt: string;
}
