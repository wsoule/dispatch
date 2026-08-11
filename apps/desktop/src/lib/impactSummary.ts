import type { ImpactReach } from '@dispatch/client';

// `ReviewRunner`'s DEPENDENT_CAP (packages/server/src/orchestrator/review.ts)
// — the number of dependents the review agent actually saw before its
// prompt was built. Hand-copied rather than imported, since apps/desktop
// talks to the server over HTTP only and does not depend on
// packages/server at runtime; server-parity.test.ts asserts the copy stays
// in sync by reading the server source as text at test time, the same
// mechanism packages/client/test/server-parity.test.ts already uses for
// IMPACT_SUBJECT_KINDS.
//
// The "coverage" sentence below relates two differently-computed sets, so
// treat it as an approximation, not an exact ratio: `ReviewRunner` caps a
// round-robin union of dependents with no hop limit, while `reach` caps at
// DEFAULT_REACH's 5 hops / 500 files merged by shortest hop. They can
// disagree on which files count at all, not just how many.
export const DEFAULT_REVIEW_CAP = 20;

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
  /** Non-null whenever `reach.unanalyzedSeeds` is non-empty — some or all of
   *  the subject's seeds fall outside what the active sources can analyse.
   *  Rendered as a caveat next to a real, nonzero count; folded into
   *  `zeroMessage` when the count is zero. */
  analysisNote: string | null;
  /** What to show in place of a bare "0" body. Usually "No files affected.";
   *  swapped for `analysisNote`-qualified wording whenever some or all
   *  seeds could not be analysed, so a genuine zero and an unknown zero
   *  never read the same in either surface. */
  zeroMessage: string;
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

// A 0 dependents count is ambiguous by itself: it means "genuinely no
// dependents" for an analysable seed, and "I never looked" for one the
// active sources can't parse (e.g. a .jsonl file under a scanner-only
// result). `reach.unanalyzedSeeds` — computed server-side against
// SOURCE_EXTENSIONS and which sources actually answered — is how the two
// are told apart here, without the UI re-deriving an extension list of its
// own. Worded for two contexts: a caveat next to a real, nonzero count
// (`allUnanalyzed: false`), or the sole message replacing a would-be "0"
// when nothing could be analysed at all (`allUnanalyzed: true`).
function analyzeSeeds(
  unanalyzedSeeds: readonly string[],
  seedCount: number
): { note: string | null; allUnanalyzed: boolean } {
  const unanalyzed = unanalyzedSeeds.length;
  if (unanalyzed === 0) return { note: null, allUnanalyzed: false };
  const noun = seedCount === 1 ? 'file' : 'files';
  if (unanalyzed === seedCount) {
    return {
      allUnanalyzed: true,
      note:
        seedCount === 1
          ? "Can't analyze this file. Impact unknown, not zero."
          : `Can't analyze any of these ${seedCount} ${noun}. Impact unknown, not zero.`,
    };
  }
  return {
    allUnanalyzed: false,
    note: `${unanalyzed} of ${seedCount} ${noun} can't be analyzed by the active sources, so the count may undercount.`,
  };
}

/** Turns a raw `ReachResult` into the counts and pre-worded strings the
 *  compact panel renders. Pure — no React, no fetch — so the honesty rules
 *  (a truncated result never reads as exact, a degraded result never reads
 *  as a plain scanner result, an unanalyzable seed never reads as a
 *  confident zero) are covered by tests without a DOM.
 *
 *  `seeds` is the subject's full seed list (`ImpactResponse.seeds`) — needed
 *  alongside `reach.unanalyzedSeeds` to tell "some seeds unanalyzed" from
 *  "every seed unanalyzed" apart.
 *
 *  `reviewCap` is the limit `ReviewRunner` applies before it hands dependents
 *  to the review agent — callers default it to `DEFAULT_REVIEW_CAP` above.
 *  `coverage` is only set once that cap actually trims what the agent saw;
 *  stating it below the real count would claim a limit that never bit. */
export function summarizeImpact(
  reach: ImpactReach,
  seeds: readonly string[],
  reviewCap: number
): ImpactSummary {
  const direct = reach.entries.filter((entry) => entry.hops === 1).length;
  const downstream = reach.entries.filter((entry) => entry.hops > 1).length;

  const label = reach.truncated
    ? `${reach.count}+ file${reach.count === 1 ? '' : 's'} (capped)`
    : `${reach.count} file${reach.count === 1 ? '' : 's'} · ${reach.maxHops} hop${reach.maxHops === 1 ? '' : 's'}`;

  // A truncated reach's count is itself a lower bound, so the denominator
  // must carry the same `+` the headline label does — otherwise a capped
  // "500+ files" reads next to an exact-looking "of 500" underneath it.
  const coverage =
    reach.count > reviewCap
      ? `review scope covered ${reviewCap} of ${reach.count}${reach.truncated ? '+' : ''}`
      : null;

  const { note: analysisNote, allUnanalyzed } = analyzeSeeds(
    reach.unanalyzedSeeds,
    seeds.length
  );
  // Every unanalyzed seed contributes no entries (the scanner never indexed
  // it), so `allUnanalyzed` implies `reach.count === 0` — the zero-count
  // body is exactly where this message is read.
  const zeroMessage =
    analysisNote === null
      ? 'No files affected.'
      : allUnanalyzed
        ? analysisNote
        : `No files affected among what could be analyzed. ${analysisNote}`;

  return {
    total: reach.count,
    direct,
    downstream,
    deepest: reach.maxHops,
    label,
    sourceLabel: describeSources(reach.sources, reach.degraded),
    coverage,
    analysisNote,
    zeroMessage,
  };
}
