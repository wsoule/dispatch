import type { ApiClient, ImpactSubjectKind } from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import {
  Chip,
  EmptyState,
  Panel,
  Skeleton,
  StatsStrip,
  Tooltip,
} from '@dispatch/ui';
import { useQuery } from '@tanstack/react-query';
import { Waypoints } from 'lucide-react';

import { DEFAULT_REVIEW_CAP, summarizeImpact } from '../../lib/impactSummary';
import styles from './ImpactPanel.module.css';

// The scanner only understands .ts/.tsx imports, so a scanner-backed result
// can look complete on a polyglot repo while missing most of it. Shown as a
// caveat on hover rather than folded into the badge text, which already
// carries the source name.
const SCANNER_CAVEAT =
  'Only .ts/.tsx imports are tracked. Other languages may be missing.';

interface ImpactPanelProps {
  client: ApiClient | null;
  subject: ImpactSubjectKind;
  id: string;
  /** Defaults to ReviewRunner's own cap so the coverage line matches what a
   *  reviewer actually saw; override only to reflect a different cap. */
  reviewCap?: number;
  className?: string;
}

// A task can resolve to an empty reach for two distinct, real reasons the
// server echoes back rather than errors — no declared writes at all, or
// declared writes that matched no tracked file (the normal state of a
// not-yet-started task). Each gets its own sentence rather than a raw reason
// id, and unrecognized reasons still surface as *something* rather than
// silently falling through to "No files affected."
function reasonMessage(reason: string | undefined): string | null {
  if (reason === 'no-declared-writes') {
    return 'This task declares no writes, so it has no blast radius to show.';
  }
  if (reason === 'writes-match-nothing') {
    return "This task's declared writes don't match any tracked file yet.";
  }
  return reason ?? null;
}

/**
 * Compact blast-radius surface: count, deepest hop, the direct-vs-downstream
 * split (a library StatsStrip of Direct, Downstream and Total, in neutral
 * ink: a bigger reach is no status), which backend(s) answered, and
 * review-scope coverage. Embedded in
 * the Review case panel, task detail, and the Git file pane — each passes
 * its own subject and this owns the fetch/loading/error states, mirroring
 * `SessionDetailModal`'s pattern for a self-contained data panel.
 *
 * All the honesty logic (truncation wording, scanner-only caveat, degraded
 * carto) lives in `summarizeImpact`; this component only renders what that
 * pure function already decided.
 */
// The words for a failed impact read. A 409 means the run has neither a
// worktree nor a saved diff to measure; the daemon's own wording for that is
// internal ("run has no worktree to diff: r-…"), so it is not shown.
export function impactErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return 'Nothing to measure: this run has no checkout or saved changes.';
  }
  return error instanceof ApiError
    ? error.message
    : "Couldn't load the blast radius.";
}

export function ImpactPanel({
  client,
  subject,
  id,
  reviewCap = DEFAULT_REVIEW_CAP,
  className,
}: ImpactPanelProps) {
  const { data, isError, error } = useQuery({
    queryKey: ['impact', client?.baseUrl, subject, id],
    queryFn: () => {
      if (client === null) throw new Error('no API client');
      return client.getImpact(subject, id);
    },
    enabled: client !== null,
    retry: false,
  });

  // Computed once here (not re-derived per section) so the header badges and
  // the body read the exact same honesty-checked wording. `resolved` is null
  // until a real (non-reason) reach comes back, which also sidesteps
  // non-null assertions below.
  const message = data ? reasonMessage(data.reason) : null;
  const resolved =
    data && message === null
      ? {
          reach: data.reach,
          summary: summarizeImpact(data.reach, data.seeds, reviewCap),
        }
      : null;
  // True while the request is still in flight AND while it is disabled
  // (e.g. no API client yet, `enabled: false` above) — a disabled query
  // never becomes `isError` and never produces `data`, so without this it
  // would fall through to a bare header forever instead of a loading state.
  const pending = !isError && data === undefined;

  // The header count is an exact number, so a capped reach (whose total is
  // only a lower bound, "5+" in the stat strip) shows none: the Capped chip
  // and the Total cell say it instead of a count that reads as exact.
  const headerCount =
    resolved && !resolved.reach.truncated ? resolved.summary.total : undefined;

  return (
    <Panel
      heading="Impact"
      className={className}
      count={headerCount}
      actions={
        resolved ? (
          <ImpactBadges
            summary={resolved.summary}
            sources={resolved.reach.sources}
            degraded={resolved.reach.degraded}
            truncated={resolved.reach.truncated}
          />
        ) : null
      }
    >
      {pending && (
        <div className={styles.loading} role="status">
          <span className="srOnly">Loading the blast radius</span>
          <Skeleton width="66%" height={14} />
          <Skeleton height={6} />
        </div>
      )}

      {isError && (
        <EmptyState icon={null}>{impactErrorMessage(error)}</EmptyState>
      )}

      {!pending && !isError && message !== null && (
        <EmptyState icon={null}>{message}</EmptyState>
      )}

      {!pending && !isError && resolved && resolved.summary.total === 0 && (
        <EmptyState icon={null}>{resolved.summary.zeroMessage}</EmptyState>
      )}

      {!pending && !isError && resolved && resolved.summary.total > 0 && (
        <ImpactBody
          summary={resolved.summary}
          truncated={resolved.reach.truncated}
        />
      )}
    </Panel>
  );
}

function ImpactBadges({
  summary,
  sources,
  degraded,
  truncated,
}: {
  summary: ReturnType<typeof summarizeImpact>;
  sources: readonly ('carto' | 'scanner')[];
  degraded: boolean;
  truncated: boolean;
}) {
  // A caveat is worth a hover explanation whenever the scanner is doing some
  // or all of the work; carto-only or carto+scanner results have nothing to
  // qualify, since carto is the broader, cross-language graph.
  const hasCaveat =
    degraded || (sources.includes('scanner') && !sources.includes('carto'));

  const badge = (
    <span className={styles.source}>
      <Waypoints size={12} strokeWidth={1.8} aria-hidden="true" />
      <Chip>{summary.sourceLabel}</Chip>
    </span>
  );

  return (
    <>
      {hasCaveat ? (
        // Focusable so the caveat reaches a keyboard too, not just a hover.
        <Tooltip content={SCANNER_CAVEAT}>
          <span tabIndex={0} className={styles.caveat}>
            {badge}
          </span>
        </Tooltip>
      ) : (
        badge
      )}
      {truncated && <Chip>Capped</Chip>}
    </>
  );
}

/** The body of a nonzero reach: the summary line ("30 files · 5 hops"), the
 *  three counts as a stat strip, then the analysis and coverage caveats. A
 *  capped reach's total is a lower bound, so it carries the same `+` the
 *  summary line does. */
function ImpactBody({
  summary,
  truncated,
}: {
  summary: ReturnType<typeof summarizeImpact>;
  truncated: boolean;
}) {
  return (
    <>
      <p className={styles.summary}>{summary.label}</p>
      <StatsStrip
        label="Blast radius"
        cells={[
          { id: 'direct', label: 'Direct', value: summary.direct },
          { id: 'downstream', label: 'Downstream', value: summary.downstream },
          {
            id: 'total',
            label: 'Total',
            value: truncated ? `${summary.total}+` : summary.total,
          },
        ]}
      />
      {summary.analysisNote && (
        <p className={styles.hint}>{summary.analysisNote}</p>
      )}
      {summary.coverage && <p className={styles.hint}>{summary.coverage}</p>}
    </>
  );
}
