// Pure data shapes, no node:* imports, so this is safe for the desktop
// webview via the '@dispatch/core/browser' entry point.

export type FindingSeverity = 'critical' | 'important' | 'minor';
export type FindingVerdict = 'open' | 'addressed' | 'parked' | 'blocked';
/** The reviewer's call on whether work may ship with this outstanding. */
export type FindingRecommendation = 'blocks' | 'park';

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
  // What the reviewer recommended, distinct from `ruling`, which is what the
  // controller decided. Absent on findings raised before this was requested.
  recommendation?: FindingRecommendation;
  round: number; // fix round that raised it, 0 for the first review
  createdAt: string;
  updatedAt: string;
  /** Serialized ActorRef of whoever raised it; empty for pre-team records. */
  raisedBy: string;
}
