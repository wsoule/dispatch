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

// The `raisedBy` a mechanical check carries, where an agent-raised finding
// carries a serialized ActorRef.
const MACHINE_RAISED_BY = 'none';

export interface CheckGroup {
  /** The rule these findings all came from. */
  rule: string;
  findings: Finding[];
  /** Every path the rule covers, deduped, in first-seen order. */
  files: string[];
}

export interface FindingPartition {
  judgment: FindingGroup[];
  checks: CheckGroup[];
}

/** The rule a check belongs to. A check that fires per file titles itself
 *  "<rule>: <path>", so the text before the first ": " groups a run of them
 *  back into the one rule that fired. */
export function ruleKeyOf(finding: Finding): string {
  const at = finding.title.indexOf(': ');
  return at === -1 ? finding.title : finding.title.slice(0, at);
}

// Paths one finding covers: a batched check carries them in `files`, a
// per-file one in `file`.
function pathsOf(finding: Finding): string[] {
  if (finding.files !== undefined) return finding.files;
  return finding.file === null ? [] : [finding.file];
}

/** Splits open findings into what an agent judged and what a deterministic
 *  check reported. They read differently — a check is verifiable and usually
 *  boring, a judgment is fallible and usually the reason to look — so the
 *  panel renders them as two sections rather than one ranked list. */
export function partitionFindings(findings: Finding[]): FindingPartition {
  const open = findings.filter((f) => f.verdict === 'open');
  const byRule = new Map<string, { group: CheckGroup; seen: Set<string> }>();
  for (const f of open) {
    if (f.raisedBy !== MACHINE_RAISED_BY) continue;
    const rule = ruleKeyOf(f);
    let entry = byRule.get(rule);
    if (entry === undefined) {
      entry = { group: { rule, findings: [], files: [] }, seen: new Set() };
      byRule.set(rule, entry);
    }
    entry.group.findings.push(f);
    for (const path of pathsOf(f)) {
      if (entry.seen.has(path)) continue;
      entry.seen.add(path);
      entry.group.files.push(path);
    }
  }
  return {
    judgment: groupOpenFindingsBySeverity(
      open.filter((f) => f.raisedBy !== MACHINE_RAISED_BY)
    ),
    checks: [...byRule.values()].map((e) => e.group),
  };
}

/** What the verdict bar prints beside Submit. Checks count rules, not rows,
 *  because one rule can span a hundred files — and a rule firing is not a
 *  reviewer disagreeing, so the two never merge into one total. */
export function findingWarnings(partition: FindingPartition): string[] {
  const open = partition.judgment.reduce((n, g) => n + g.findings.length, 0);
  const rules = partition.checks.length;
  const clauses: string[] = [];
  if (open > 0) clauses.push(`${open} open finding${open === 1 ? '' : 's'}`);
  if (rules > 0) clauses.push(`${rules} check${rules === 1 ? '' : 's'} fired`);
  return clauses;
}
