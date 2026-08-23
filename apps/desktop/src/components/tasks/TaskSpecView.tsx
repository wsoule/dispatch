import type { Priority, TaskRisk } from '@dispatch/core/browser';
import { statusLabel } from '@dispatch/core/browser';
import { Circle, FilePen, Link2, ListChecks } from 'lucide-react';

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

/** Uppercase micro-label above each spec section — same treatment as the plan view's
 * "Milestone" card label so the two surfaces read as one family. */
function SectionLabel({
  icon: Icon,
  children,
}: {
  icon: typeof ListChecks;
  children: string;
}) {
  return (
    <div className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
      <Icon className="size-3" />
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
 * criteria, declared writes, risk, and blockers. Built for the plan page's draft-expansion
 * dialog first, shaped to become the task page's detail body when that view is rewritten:
 * it takes only the `TaskSpec` projection, never a live TaskDoc, so it stays free of run,
 * ledger, and fix-loop concerns by construction.
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
    <div className={cn('flex flex-col gap-4', className)}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
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
        <h2 className="text-[15px] leading-snug font-semibold">{spec.title}</h2>
      </div>

      {spec.description.trim() !== '' && (
        <Markdown
          content={spec.description}
          className="text-muted-foreground text-[13px]"
        />
      )}

      {spec.acceptanceCriteria.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <SectionLabel icon={ListChecks}>Acceptance criteria</SectionLabel>
          <ul className="flex flex-col gap-1">
            {spec.acceptanceCriteria.map((criterion, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-[13px] leading-snug"
              >
                <Circle className="text-muted-foreground/50 size-3 shrink-0 translate-y-0.5" />
                <span>{criterion}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {spec.writes.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <SectionLabel icon={FilePen}>Writes</SectionLabel>
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
        </div>
      )}

      {spec.blockedBy.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <SectionLabel icon={Link2}>Blocked by</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {spec.blockedBy.map((blocker) =>
              onOpenBlocker !== undefined ? (
                <button
                  key={blocker.key}
                  type="button"
                  onClick={() => onOpenBlocker(blocker.key)}
                  className="rounded-control focus-visible:ring-ring/40 focus-visible:ring-1 focus-visible:outline-none"
                  aria-label={`Open ${blocker.title}`}
                >
                  <Badge
                    variant="secondary"
                    title={blocker.title}
                    className="hover:bg-accent max-w-[16rem] cursor-pointer justify-start font-normal"
                  >
                    <span className="truncate">{blocker.title}</span>
                  </Badge>
                </button>
              ) : (
                <Badge
                  key={blocker.key}
                  variant="secondary"
                  title={blocker.title}
                  className="max-w-[16rem] justify-start font-normal"
                >
                  <span className="truncate">{blocker.title}</span>
                </Badge>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
