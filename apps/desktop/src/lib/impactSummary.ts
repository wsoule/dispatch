import type { ImpactReach } from '@dispatch/client';

/** What `ImpactPanel` renders: numbers plus wording that has already been
 *  checked against the honesty rules (truncation, source coverage, degraded
 *  carto), so the component itself never has to reason about them. */
export interface ImpactSummary {
  total: number;
  direct: number; // hops === 1
  downstream: number; // hops > 1
  deepest: number;
  label: string; // e.g. "30 files · 5 hops" or "500+ files (capped)"
  sourceLabel: string; // e.g. "carto + scanner" or "scanner only (.ts/.tsx)"
  coverage: string | null; // e.g. "review scope covered 20 of 30"
}

const SCANNER_NOTE = 'scanner only (.ts/.tsx)';

// The built-in scanner only understands .ts/.tsx imports, so a scanner-only
// number on a polyglot repo can look complete while being blind to most of
// the repo. `degraded` means carto was configured but unavailable for this
// one call — a different statement from "this repo never had carto" — so it
// gets its own wording rather than collapsing into a plain scanner result.
function describeSources(
  sources: readonly ('carto' | 'scanner')[],
  degraded: boolean
): string {
  if (degraded) return `carto unavailable — ${SCANNER_NOTE}`;
  const hasCarto = sources.includes('carto');
  const hasScanner = sources.includes('scanner');
  if (hasCarto && hasScanner) return 'carto + scanner';
  if (hasCarto) return 'carto only';
  if (hasScanner) return SCANNER_NOTE;
  return 'no sources';
}

/** Turns a raw `ReachResult` into the counts and pre-worded strings the
 *  compact panel renders. Pure — no React, no fetch — so the honesty rules
 *  (a truncated result never reads as exact, a degraded result never reads
 *  as a plain scanner result) are covered by tests without a DOM.
 *
 *  `reviewCap` is the limit `ReviewRunner` applies before it hands dependents
 *  to the review agent (`DEPENDENT_CAP` in
 *  packages/server/src/orchestrator/review.ts) — passed in rather than
 *  imported, since apps/desktop cannot depend on packages/server. `coverage`
 *  is only set once that cap actually trims what the agent saw; stating it
 *  below the real count would claim a limit that never bit. */
export function summarizeImpact(
  reach: ImpactReach,
  reviewCap: number
): ImpactSummary {
  const direct = reach.entries.filter((entry) => entry.hops === 1).length;
  const downstream = reach.entries.filter((entry) => entry.hops > 1).length;

  const label = reach.truncated
    ? `${reach.count}+ file${reach.count === 1 ? '' : 's'} (capped)`
    : `${reach.count} file${reach.count === 1 ? '' : 's'} · ${reach.maxHops} hop${reach.maxHops === 1 ? '' : 's'}`;

  const coverage =
    reach.count > reviewCap
      ? `review scope covered ${reviewCap} of ${reach.count}`
      : null;

  return {
    total: reach.count,
    direct,
    downstream,
    deepest: reach.maxHops,
    label,
    sourceLabel: describeSources(reach.sources, reach.degraded),
    coverage,
  };
}
