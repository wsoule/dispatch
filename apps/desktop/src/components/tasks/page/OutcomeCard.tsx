import type { RunMeta } from '@dispatch/client';
import {
  CircleCheck,
  CircleSlash,
  CircleX,
  Eye,
  GitMerge,
  GitPullRequest,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';

import { modelLabel } from '../../../lib/models';
import { formatShortDate } from '../../../lib/taskDates';
import type { TaskOutcome } from '../../../lib/taskOutcome';
import { LandedAs } from '../../runs/LandedAs';
import type { TaskPageModel } from './pageModel';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';

type Tone = 'landing' | 'waiting' | 'failed' | 'review' | 'ready';

// Each tone is one of the run-state roles, so the card reads in the same
// colour as the status icons and pills around it.
const TONE: Record<Tone, string> = {
  landing: 'bg-(--state-landing-surface) text-(--state-landing-fg)',
  waiting: 'bg-(--state-waiting-surface) text-(--state-waiting-fg)',
  failed: 'bg-(--state-failed-surface) text-(--state-failed-fg)',
  review: 'bg-(--state-review-surface) text-(--state-review-fg)',
  ready: 'bg-(--state-ready-surface) text-(--state-ready-fg)',
};

/** "claude · Opus 5 · 9 turns · $1.50 · Jul 20", from whatever the run recorded. */
function runFacts(run: RunMeta | undefined, at?: string): string {
  if (run === undefined) return at === undefined ? '' : formatShortDate(at);
  const parts = [run.executor];
  if (run.model !== undefined) parts.push(modelLabel(run.model));
  if (run.turns !== undefined) parts.push(`${run.turns} turns`);
  if (run.costUsd !== undefined) parts.push(`$${run.costUsd.toFixed(2)}`);
  parts.push(formatShortDate(at ?? run.reviewedAt ?? run.updatedAt));
  return parts.join(' · ');
}

interface Shape {
  tone: Tone;
  icon: ComponentType<{ className?: string }>;
  title: string;
  detail: ReactNode;
  actions: ReactNode;
}

/**
 * How a finished task ended, said once at the top of Summary and Review: one
 * title, the run's facts, where the work went, and only the actions that make
 * sense now. On Review the run strip owns the actions, so the card only says
 * what happened.
 */
export function OutcomeCard({
  outcome,
  page,
  place,
  updatedAt,
}: {
  outcome: TaskOutcome;
  page: TaskPageModel;
  place: 'summary' | 'review';
  /** When the task last changed: the date for outcomes no run dates. */
  updatedAt: string;
}) {
  const { project } = page;
  const landedAs = (run: RunMeta) => (
    <LandedAs
      run={run}
      originWebUrl={project.health?.originWebUrl}
      onPublish={project.handlePublishRun}
    />
  );
  const openRun = (run: RunMeta) => (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        page.selectRun(run.id);
        page.selectMode('run');
      }}
    >
      Open the run
    </Button>
  );

  let shape: Shape;
  switch (outcome.kind) {
    case 'landed':
      shape = {
        tone: 'landing',
        icon: CircleCheck,
        title:
          outcome.where === 'origin'
            ? 'Landed on origin'
            : outcome.where === 'local'
              ? 'Landed locally'
              : outcome.run === undefined
                ? 'Done'
                : 'Landed',
        detail:
          outcome.where === 'outside' ? (
            <span>
              {outcome.run === undefined
                ? 'Closed without an agent run.'
                : 'Merged outside the queue, so no commit was recorded here.'}
            </span>
          ) : (
            outcome.run !== undefined && landedAs(outcome.run)
          ),
        actions: null,
      };
      break;
    case 'merged-local':
      shape = {
        tone: 'waiting',
        icon: TriangleAlert,
        title: 'Merged locally, not on origin yet',
        detail: landedAs(outcome.run),
        actions: null,
      };
      break;
    case 'pr-open':
      shape = {
        tone: 'landing',
        icon: GitPullRequest,
        title: 'Waiting on the pull request',
        detail: <span>It lands when the PR merges on GitHub.</span>,
        actions: (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => page.host.openPr(outcome.run.id)}
          >
            <GitPullRequest />
            Review PR
          </Button>
        ),
      };
      break;
    case 'land-failed':
      shape = {
        tone: 'failed',
        icon: CircleX,
        title: 'Landing failed',
        detail: <span className="break-words">{outcome.reason}</span>,
        actions: (
          <Button
            size="sm"
            onClick={() =>
              void project
                .handleReview(outcome.run.id, 'merge')
                .catch((err: unknown) => page.fail('Landing failed again', err))
            }
          >
            <GitMerge />
            Retry landing
          </Button>
        ),
      };
      break;
    case 'run-failed':
      shape = {
        tone: 'failed',
        icon: CircleX,
        title: 'The run failed',
        detail: (
          <span className="break-words">
            {outcome.reason ?? 'It stopped before finishing. Nothing landed.'}
          </span>
        ),
        actions: (
          <>
            {openRun(outcome.run)}
            <Button
              size="sm"
              onClick={() =>
                void page
                  .dispatch()
                  .catch((err: unknown) => page.fail('Could not re-run', err))
              }
            >
              <RotateCcw />
              Re-run
            </Button>
          </>
        ),
      };
      break;
    case 'ready':
      shape = {
        tone: 'review',
        icon: Eye,
        title: 'Ready for review',
        detail: <span>The agent finished. Land it, or ask for changes.</span>,
        actions:
          place === 'summary' ? (
            <Button size="sm" onClick={() => page.selectMode('review')}>
              <Eye />
              Review
            </Button>
          ) : null,
      };
      break;
    case 'dropped':
      shape = {
        tone: 'ready',
        icon: CircleSlash,
        title: 'Dropped',
        detail: <span>Nothing landed. The history stays below.</span>,
        actions: null,
      };
      break;
  }

  const run = 'run' in outcome ? outcome.run : undefined;
  const facts = runFacts(run, run === undefined ? updatedAt : undefined);
  const Icon = shape.icon;
  return (
    <section
      data-slot="outcome-card"
      data-outcome={outcome.kind}
      aria-label={shape.title}
      className="border-border rounded-card flex flex-col gap-3 border-[0.5px] p-3 sm:flex-row sm:items-center"
    >
      <span
        className={cn(
          'grid size-9 shrink-0 place-items-center rounded-full',
          TONE[shape.tone]
        )}
      >
        <Icon className="size-[18px]" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h3 className="text-foreground text-[15px] font-semibold">
          {shape.title}
        </h3>
        <div className="font-book flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-(--text-secondary)">
          {shape.detail}
        </div>
        {facts !== '' && (
          <p className="text-muted-foreground font-book text-[12px] tabular-nums">
            {facts}
          </p>
        )}
      </div>
      {/* On Review the run strip below carries the actions already. */}
      {place === 'summary' && shape.actions !== null && (
        <div className="flex shrink-0 items-center gap-2">{shape.actions}</div>
      )}
    </section>
  );
}
