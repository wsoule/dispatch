import type { Finding, FindingSeverity } from '@dispatch/core/browser';

// Rendering order for the findings panel — most severe first, so a critical
// finding is never scrolled past a page of minor ones.
export const SEVERITY_ORDER: readonly FindingSeverity[] = [
  'critical',
  'important',
  'minor',
];

export interface FindingGroup {
  severity: FindingSeverity;
  findings: Finding[];
}

/** Open findings only, bucketed by severity in `SEVERITY_ORDER`; a severity
 *  with nothing open is omitted rather than rendered as an empty group. */
export function groupOpenFindingsBySeverity(
  findings: Finding[]
): FindingGroup[] {
  const open = findings.filter((f) => f.verdict === 'open');
  return SEVERITY_ORDER.map((severity) => ({
    severity,
    findings: open.filter((f) => f.severity === severity),
  })).filter((group) => group.findings.length > 0);
}

export interface FindingCounts {
  open: number;
  critical: number;
  important: number;
  minor: number;
}

/** Counts of open findings, overall and per severity — the panel header and
 *  any future summary chip both read from this rather than re-filtering. */
export function countOpenFindings(findings: Finding[]): FindingCounts {
  const open = findings.filter((f) => f.verdict === 'open');
  return {
    open: open.length,
    critical: open.filter((f) => f.severity === 'critical').length,
    important: open.filter((f) => f.severity === 'important').length,
    minor: open.filter((f) => f.severity === 'minor').length,
  };
}
