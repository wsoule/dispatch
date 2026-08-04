import type { Finding, FindingSeverity } from '@dispatch/client';

import { SEVERITY_ORDER } from './findings';

/** One tree-row decoration. `@pierre/trees` renders a single text-or-icon
 *  value per row, so everything worth saying composes into one token. */
export interface RowDecoration {
  text: string;
  title: string;
}

/**
 * The decoration for one file row: its worst open finding, its unresolved comment count, and its
 * viewed tick, in that order — severity first because it is the only one of the three the
 * reviewer did not put there themselves.
 *
 * Returns null for a file with none of them, so an untouched tree stays clean rather than
 * carrying a column of empty markers.
 */
export function composeRowDecoration(input: {
  viewed: boolean;
  comments: number;
  severity?: FindingSeverity | null;
}): RowDecoration | null {
  const parts: string[] = [];
  const titles: string[] = [];
  if (input.severity != null) {
    parts.push('⚠');
    titles.push(`${input.severity} finding`);
  }
  if (input.comments > 0) {
    parts.push(String(input.comments));
    titles.push(
      `${input.comments} unresolved comment${input.comments === 1 ? '' : 's'}`
    );
  }
  if (input.viewed) {
    parts.push('✓');
    titles.push('Viewed');
  }
  if (parts.length === 0) return null;
  return { text: parts.join(' '), title: titles.join(' · ') };
}

/** Open findings bucketed by file. Findings with no file belong to the case panel, not to a
 *  row, so they are dropped rather than collected under an empty key. */
export function openFindingsByFile(
  findings: Finding[]
): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const f of findings) {
    if (f.verdict !== 'open' || f.file === null) continue;
    const bucket = map.get(f.file);
    if (bucket === undefined) map.set(f.file, [f]);
    else bucket.push(f);
  }
  return map;
}

/** The most severe open finding's severity, or null when none are open — what ranks a file
 *  into "needs your eyes". */
export function worstSeverity(findings: Finding[]): FindingSeverity | null {
  const open = findings.filter((f) => f.verdict === 'open');
  return SEVERITY_ORDER.find((s) => open.some((f) => f.severity === s)) ?? null;
}

export interface AttentionSplit {
  /** False when nothing ranks the files, so the caller renders one plain tree rather than
   *  two sections. */
  grouped: boolean;
  needsEyes: string[];
  mechanical: string[];
}

/**
 * Splits the changed files into what wants a human's attention and what does not, ranked by
 * worst open finding then path.
 *
 * Returns `grouped: false` when nothing ranks them — the common case, where no agent review has
 * run and nobody has commented. Grouping there would file every file under "mechanical" on the
 * strength of no evidence at all, which is a judgement the page has not earned.
 */
export function splitByAttention(
  paths: readonly string[],
  findingsByFile: ReadonlyMap<string, Finding[]>,
  commentsByFile: ReadonlyMap<string, number>
): AttentionSplit {
  // -1 sorts nothing; a severity's index ranks findings against each other; the length puts a
  // merely-commented file below every finding.
  const rank = (path: string): number => {
    const severity = worstSeverity(findingsByFile.get(path) ?? []);
    if (severity !== null) return SEVERITY_ORDER.indexOf(severity);
    return (commentsByFile.get(path) ?? 0) > 0 ? SEVERITY_ORDER.length : -1;
  };
  if (paths.every((p) => rank(p) === -1)) {
    return { grouped: false, needsEyes: [], mechanical: [] };
  }
  return {
    grouped: true,
    needsEyes: paths
      .filter((p) => rank(p) !== -1)
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)),
    mechanical: paths.filter((p) => rank(p) === -1),
  };
}
