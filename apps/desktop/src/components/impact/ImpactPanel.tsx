import type { ApiClient, ImpactSubjectKind } from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import { useQuery } from '@tanstack/react-query';
import { Waypoints } from 'lucide-react';

import { summarizeImpact } from '../../lib/impactSummary';
import { Badge } from '@/ui/badge';
import {
  EmptyState,
  HintText,
  MetaText,
  Panel,
  PanelHeader,
  PanelRow,
} from '@/ui/chrome';
import { Skeleton } from '@/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

// `ReviewRunner`'s DEPENDENT_CAP (packages/server/src/orchestrator/review.ts)
// — the number of dependents the review agent actually saw. Passed as a
// default rather than imported: apps/desktop talks to the server over HTTP
// only and does not depend on packages/server.
const DEFAULT_REVIEW_CAP = 20;

// The scanner only understands .ts/.tsx imports, so a scanner-backed result
// can look complete on a polyglot repo while missing most of it. Shown as a
// caveat on hover rather than folded into the badge text, which already
// carries the source name.
const SCANNER_CAVEAT =
  'The built-in scanner only tracks .ts/.tsx imports — dependents in other languages may be missing from this count.';

interface ImpactPanelProps {
  client: ApiClient | null;
  subject: ImpactSubjectKind;
  id: string;
  /** Defaults to ReviewRunner's own cap so the coverage line matches what a
   *  reviewer actually saw; override only to reflect a different cap. */
  reviewCap?: number;
  className?: string;
}

/** The bar splitting a subject's direct dependents (one hop) from everything
 *  further out. No existing chrome primitive draws two proportioned
 *  segments — `ProgressTrack` is a single value against a fixed track — so
 *  this composes the same track+fill shape from token colours instead of
 *  reaching for shadcn's `progress`. */
function HopSplitBar({
  direct,
  downstream,
}: {
  direct: number;
  downstream: number;
}) {
  const total = direct + downstream;
  const directPct = total === 0 ? 0 : Math.round((direct / total) * 100);
  return (
    <div
      role="img"
      aria-label={`${direct} direct, ${downstream} downstream`}
      className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
    >
      <div
        className="bg-foreground h-full"
        style={{ width: `${directPct}%` }}
      />
    </div>
  );
}

// A task with no declared `writes` resolves to an empty reach with this
// reason echoed by the server — a real answer, not an error, so it reads as
// its own sentence rather than the raw `no-declared-writes` string.
function reasonMessage(reason: string | undefined): string | null {
  if (reason === 'no-declared-writes') {
    return 'This task declares no writes, so it has no blast radius to show.';
  }
  return reason ?? null;
}

/**
 * Compact blast-radius surface: count, deepest hop, the direct-vs-downstream
 * split, which backend(s) answered, and review-scope coverage. Embedded in
 * the Review case panel, task detail, and the Git file pane — each passes
 * its own subject and this owns the fetch/loading/error states, mirroring
 * `SessionDetailModal`'s pattern for a self-contained data panel.
 *
 * All the honesty logic (truncation wording, scanner-only caveat, degraded
 * carto) lives in `summarizeImpact`; this component only renders what that
 * pure function already decided.
 */
export function ImpactPanel({
  client,
  subject,
  id,
  reviewCap = DEFAULT_REVIEW_CAP,
  className,
}: ImpactPanelProps) {
  const { data, isLoading, isError, error } = useQuery({
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
      ? { reach: data.reach, summary: summarizeImpact(data.reach, reviewCap) }
      : null;

  return (
    <Panel className={className}>
      <PanelHeader
        count={resolved ? resolved.summary.total : undefined}
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
        Impact
      </PanelHeader>

      {isLoading && (
        <div className="flex flex-col gap-2 p-3">
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-1.5 w-full" />
        </div>
      )}

      {isError && (
        <EmptyState
          message={
            error instanceof ApiError
              ? error.message
              : "Couldn't load the blast radius."
          }
        />
      )}

      {!isLoading && !isError && message !== null && (
        <EmptyState message={message} />
      )}

      {!isLoading && !isError && resolved && resolved.summary.total === 0 && (
        <EmptyState message="No files affected." />
      )}

      {!isLoading && !isError && resolved && resolved.summary.total > 0 && (
        <ImpactBody summary={resolved.summary} />
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
  // or all of the work — carto-only or carto+scanner results have nothing to
  // qualify, since carto is the broader, cross-language graph.
  const hasCaveat =
    degraded || (sources.includes('scanner') && !sources.includes('carto'));

  const badge = (
    <Badge variant="secondary">
      <Waypoints className="size-3" />
      {summary.sourceLabel}
    </Badge>
  );

  return (
    <>
      {hasCaveat ? (
        <Tooltip>
          <TooltipTrigger asChild>{badge}</TooltipTrigger>
          <TooltipContent>{SCANNER_CAVEAT}</TooltipContent>
        </Tooltip>
      ) : (
        badge
      )}
      {truncated && <Badge variant="outline">capped</Badge>}
    </>
  );
}

function ImpactBody({
  summary,
}: {
  summary: ReturnType<typeof summarizeImpact>;
}) {
  return (
    <PanelRow className="flex-col items-stretch gap-2">
      <div className="flex items-center justify-between gap-2">
        <MetaText>
          {summary.direct} direct · {summary.downstream} downstream
        </MetaText>
        <MetaText>{summary.label}</MetaText>
      </div>
      <HopSplitBar direct={summary.direct} downstream={summary.downstream} />
      {summary.coverage && <HintText>{summary.coverage}</HintText>}
    </PanelRow>
  );
}
