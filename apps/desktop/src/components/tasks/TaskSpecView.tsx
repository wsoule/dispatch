import type { Priority, TaskRisk } from '@dispatch/core/browser';
import { statusLabel } from '@dispatch/core/browser';
import { Circle } from 'lucide-react';

import { Markdown } from '../runs/Markdown';
import { PriorityIcon } from './PriorityIcon';
import { StatusIcon } from './StatusIcon';
import { cn } from '@/lib/utils';
import { Badge } from '@/ui/badge';

/**
 * The spec-shaped slice of a task: what it is and what done means, independent of any live
 * run state. Both a plan's still-unconfirmed drafts and real TaskDocs project onto this, so
 * the plan review and the task page render the same detail body.
 */
export interface TaskSpec {
  title: string;
  /** A canonical or custom status string — 'draft' for plan proposals. */
  status: string;
  priority: Priority;
  description: string;
  acceptanceCriteria: string[];
  writes: string[];
  risk?: TaskRisk;
  /** Blocking tasks by display title. `onOpenBlocker` receives the entry's `key`. */
  blockedBy: { key: string; title: string }[];
}

const RISK_BADGE_CLASSES: Record<'elevated' | 'critical', string> = {
  elevated:
    'border-amber-500/40 text-amber-600 dark:text-amber-400 bg-amber-500/10',
  critical: 'border-destructive/40 text-destructive bg-destructive/10',
};

/** One inset, top-bordered section with a micro-label — RecommendationCard's "Other
 * options" panel treatment, which is the shape every spec section below shares. */
function SpecSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-border bg-surface-inset border-t px-4 py-2.5">
      <p className="text-muted-foreground pb-1.5 text-[11px] font-medium">
        {label}
      </p>
      {children}
    </div>
  );
}

export interface TaskSpecViewProps {
  spec: TaskSpec;
  /** Jumps to a blocking task (dialog swap on the plan page; navigation on the task page). */
  onOpenBlocker?: (key: string) => void;
  className?: string;
}

/**
 * Read-only rendering of one task's spec — status, priority, description, acceptance
 * criteria, declared writes, risk, and blockers — in the ai components' RecommendationCard
 * language: a round accent-tinted icon badge beside a bold title and muted rationale, then
 * inset top-bordered sections. Built for the plan page's draft-expansion dialog first,
 * shaped to become the task page's detail body when that view is rewritten: it takes only
 * the `TaskSpec` projection, never a live TaskDoc, so it stays free of run, ledger, and
 * fix-loop concerns by construction. Expects a zero-padding container (sections carry
 * their own edge-to-edge padding, like RecommendationCard).
 */
export function TaskSpecView({
  spec,
  onOpenBlocker,
  className,
}: TaskSpecViewProps) {
  // 'routine' is the default risk everywhere — only the two elevated tiers earn a badge.
  const riskBadge =
    spec.risk === 'elevated' || spec.risk === 'critical' ? spec.risk : null;

  return (
    <div className={cn('flex flex-col', className)}>
      <div className="flex items-start gap-2.5 px-4 pt-4 pb-3">
        {/* Accent tint like every ai-component badge; the glyph itself is the status, so the
            card still leads with "this is a draft" without a gray-on-gray header. */}
        <span className="bg-accent-tint flex size-7 shrink-0 items-center justify-center rounded-full">
          <StatusIcon status={spec.status} className="text-primary size-4" />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <h2 className="text-foreground text-[13px] font-semibold text-pretty">
            {spec.title}
          </h2>
          {spec.description.trim() !== '' && (
            <Markdown
              content={spec.description}
              className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed"
            />
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
        <Badge variant="outline" className="gap-1.5 font-normal">
          <StatusIcon status={spec.status} className="size-3" />
          {statusLabel(spec.status)}
        </Badge>
        <Badge variant="outline" className="gap-1.5 font-normal capitalize">
          <PriorityIcon priority={spec.priority} className="size-3" />
          {spec.priority}
        </Badge>
        {riskBadge !== null && (
          <Badge
            variant="outline"
            className={cn(
              'font-normal capitalize',
              RISK_BADGE_CLASSES[riskBadge]
            )}
          >
            {riskBadge} risk
          </Badge>
        )}
      </div>

      {spec.acceptanceCriteria.length > 0 && (
        <SpecSection label="Acceptance criteria">
          <ul className="flex flex-col gap-1">
            {spec.acceptanceCriteria.map((criterion, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-[12.5px] leading-snug"
              >
                <Circle className="text-muted-foreground/50 size-3 shrink-0 translate-y-0.5" />
                <span>{criterion}</span>
              </li>
            ))}
          </ul>
        </SpecSection>
      )}

      {spec.writes.length > 0 && (
        <SpecSection label="Writes">
          <div className="flex flex-wrap gap-1.5">
            {spec.writes.map((glob) => (
              <Badge
                key={glob}
                variant="secondary"
                className="font-mono text-[11px] font-normal"
              >
                {glob}
              </Badge>
            ))}
          </div>
        </SpecSection>
      )}

      {spec.blockedBy.length > 0 && (
        <SpecSection label="Blocked by">
          {/* Full-width hover rows, not chips — RecommendationCard's alternatives list. */}
          <div className="-mx-1.5 flex flex-col">
            {spec.blockedBy.map((blocker) =>
              onOpenBlocker !== undefined ? (
                <button
                  key={blocker.key}
                  type="button"
                  onClick={() => onOpenBlocker(blocker.key)}
                  className="hover:bg-surface-hover rounded-control ease-out-expo flex w-full items-center gap-2.5 px-1.5 py-1.5 text-left transition-colors duration-100"
                >
                  <span className="text-foreground min-w-0 flex-1 truncate text-[12.5px]">
                    {blocker.title}
                  </span>
                </button>
              ) : (
                <span
                  key={blocker.key}
                  className="text-foreground flex w-full items-center px-1.5 py-1.5 text-[12.5px]"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {blocker.title}
                  </span>
                </span>
              )
            )}
          </div>
        </SpecSection>
      )}
    </div>
  );
}
