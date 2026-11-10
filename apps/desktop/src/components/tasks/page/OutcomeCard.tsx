import type { RunMeta } from '@dispatch/client';
import { Button, cx, type UiTone } from '@dispatch/ui';
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
import type { ReactNode } from 'react';

import { modelLabel } from '../../../lib/models';
import { formatShortDate } from '../../../lib/taskDates';
import type { TaskOutcome } from '../../../lib/taskOutcome';
import { LandedAs } from '../../runs/LandedAs';
import styles from './pageBlocks.module.css';
import type { TaskPageModel } from './pageModel';

// The 14px lucide glyph of an outcome, drawn in the mark's tone.
type OutcomeIcon = typeof CircleCheck;

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
  /** The mark's status colour: default (a filled neutral done mark) for landed work,
   * warning for merged but not on origin, info while a PR is open, danger for a failure,
   * success for work that finished and waits on review, muted for dropped. */
  tone: UiTone;
  icon: OutcomeIcon;
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
      variant="quiet"
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
        tone: 'default',
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
        tone: 'warning',
        icon: TriangleAlert,
        title: 'Merged locally, not on origin yet',
        detail: landedAs(outcome.run),
        actions: null,
      };
      break;
    case 'pr-open':
      shape = {
        tone: 'info',
        icon: GitPullRequest,
        title: 'Waiting on the pull request',
        detail: <span>It lands when the PR merges on GitHub.</span>,
        actions: (
          <Button
            size="sm"
            variant="secondary"
            icon={<GitPullRequest size={14} strokeWidth={1.8} aria-hidden />}
            onClick={() => page.host.openPr(outcome.run.id)}
          >
            Review PR
          </Button>
        ),
      };
      break;
    case 'land-failed':
      shape = {
        tone: 'danger',
        icon: CircleX,
        title: 'Landing failed',
        detail: <span className={styles.outcomeReason}>{outcome.reason}</span>,
        actions: (
          <Button
            size="sm"
            variant="primary"
            icon={<GitMerge size={14} strokeWidth={1.8} aria-hidden />}
            onClick={() =>
              void project
                .handleReview(outcome.run.id, 'merge')
                .catch((err: unknown) => page.fail('Landing failed again', err))
            }
          >
            Retry landing
          </Button>
        ),
      };
      break;
    case 'run-failed':
      shape = {
        tone: 'danger',
        icon: CircleX,
        title: 'The run failed',
        detail: (
          <span className={styles.outcomeReason}>
            {outcome.reason ?? 'It stopped before finishing. Nothing landed.'}
          </span>
        ),
        actions: (
          <>
            {openRun(outcome.run)}
            <Button
              size="sm"
              variant="primary"
              icon={<RotateCcw size={14} strokeWidth={1.8} aria-hidden />}
              onClick={() =>
                void page
                  .dispatch()
                  .catch((err: unknown) => page.fail('Could not re-run', err))
              }
            >
              Re-run
            </Button>
          </>
        ),
      };
      break;
    case 'ready':
      shape = {
        tone: 'success',
        icon: Eye,
        title: 'Ready for review',
        detail: <span>The agent finished. Land it, or ask for changes.</span>,
        actions:
          place === 'summary' ? (
            <Button
              size="sm"
              variant="primary"
              icon={<Eye size={14} strokeWidth={1.8} aria-hidden />}
              onClick={() => page.selectMode('review')}
            >
              Review
            </Button>
          ) : null,
      };
      break;
    case 'dropped':
      shape = {
        tone: 'muted',
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
      className={styles.outcome}
    >
      <span
        className={styles.outcomeMark}
        data-tone={shape.tone}
        aria-hidden="true"
      >
        <Icon size={16} strokeWidth={1.8} aria-hidden />
      </span>
      <div className={styles.outcomeBody}>
        <h3 className={styles.outcomeTitle}>{shape.title}</h3>
        <div className={styles.outcomeDetail}>{shape.detail}</div>
        {facts !== '' && (
          <p className={cx(styles.outcomeFacts, 'num')}>{facts}</p>
        )}
      </div>
      {/* On Review the run strip below carries the actions already. */}
      {place === 'summary' && shape.actions !== null && (
        <div className={styles.outcomeActions}>{shape.actions}</div>
      )}
    </section>
  );
}
