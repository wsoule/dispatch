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
  /** Other paths this finding covers, when one check fires across many files
   *  at once. Absent on findings about a single location. */
  files?: string[];
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

// The write surface every findings backend takes. Declared here beside the
// record it produces so the file-backed store in the daemon and the
// database-backed one in sqliteRecords.ts agree on inputs without either
// importing the other.

export interface AddFindingInput {
  taskId: string;
  runId: string | null;
  severity: FindingSeverity;
  title: string;
  detail: string;
  file?: string | null;
  line?: number | null;
  /** Paths this finding covers when one check fired across many files. */
  files?: string[];
  round?: number;
  recommendation?: FindingRecommendation;
  /** Serialized ActorRef of whoever raised it. */
  raisedBy: string;
}

export interface FindingUpdatePatch {
  verdict?: FindingVerdict;
  ruling?: string | null;
}

export interface FindingListFilter {
  taskId?: string;
  verdict?: FindingVerdict;
  severity?: FindingSeverity;
}

// Runtime counterparts of the closed sets above, for readers that have to
// check a value rather than trust it — the SQLite backend validates every
// enum column against these. Mirrors how types.ts pairs STATUSES/KINDS with
// their types.
export const FINDING_SEVERITIES: readonly FindingSeverity[] = [
  'critical',
  'important',
  'minor',
];
export const FINDING_VERDICTS: readonly FindingVerdict[] = [
  'open',
  'addressed',
  'parked',
  'blocked',
];
export const FINDING_RECOMMENDATIONS: readonly FindingRecommendation[] = [
  'blocks',
  'park',
];
