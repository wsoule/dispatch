import type { RunMeta } from '@dispatch/client';
import { ArrowUpRight, GitCommitHorizontal, RotateCcw } from 'lucide-react';
import { useState } from 'react';

import {
  landedCommitUrl,
  mergeLadderLabel,
  mergeLadderState,
  releaseLabel,
} from '../../lib/mergeLadder';
import { Pill } from '@/ui/ai/pill';
import { Button } from '@/ui/button';

interface LandedAsProps {
  run: RunMeta;
  /** origin's GitHub URL (health's `originWebUrl`), for the commit link. */
  originWebUrl: string | undefined;
  /** The one-click retry for a merge that never reached origin. Absent where
   * the surface has no room for it; the label still says what is wrong. */
  onPublish?: (runId: string) => Promise<void>;
}

/**
 * Where a run's work went, said the same way on every surface: "Landed on
 * origin/main · abc1234" with the sha linking to GitHub and whether the newest
 * release carries it, "Landed locally (no remote)", or, for a squash that only
 * reached this machine, "Merged locally — not on GitHub yet" with a retry.
 * Never a bare "landed".
 */
export function LandedAs({ run, originWebUrl, onPublish }: LandedAsProps) {
  const [publishing, setPublishing] = useState(false);
  const state = mergeLadderState(run);
  const url = landedCommitUrl(run, originWebUrl);
  const release = releaseLabel(run);
  const sha =
    run.mergeCommit === undefined ? null : (
      <Pill className="font-mono font-normal" title={run.mergeCommit}>
        <GitCommitHorizontal />
        {run.mergeCommit.slice(0, 7)}
        {url !== undefined && (
          <ArrowUpRight className="text-muted-foreground" />
        )}
      </Pill>
    );
  return (
    <span
      data-landing={state}
      className="font-book inline-flex flex-wrap items-center gap-2"
    >
      {state !== 'unmerged' && (
        <span
          className={
            state === 'merged-local'
              ? 'font-medium text-(--state-waiting-fg)'
              : undefined
          }
        >
          {/* The sha is its own pill below, so the sentence stops at the branch. */}
          {state === 'on-origin' && run.mergeCommit !== undefined
            ? `Landed on origin/${run.baseBranch}`
            : mergeLadderLabel(run)}
        </span>
      )}
      {sha !== null &&
        (url !== undefined ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${run.mergeCommit?.slice(0, 7)} on GitHub`}
          >
            {sha}
          </a>
        ) : (
          sha
        ))}
      {release !== undefined && (
        <Pill data-release={run.release?.included === true ? 'in' : 'not-yet'}>
          {release}
        </Pill>
      )}
      {state === 'merged-local' && onPublish !== undefined && (
        <Button
          size="xs"
          variant="outline"
          disabled={publishing}
          title={`Replay this merge onto origin/${run.baseBranch} and push it`}
          onClick={() => {
            setPublishing(true);
            void onPublish(run.id).finally(() => setPublishing(false));
          }}
        >
          <RotateCcw />
          {publishing ? 'Pushing…' : 'Push to origin'}
        </Button>
      )}
      {run.prUrl !== undefined && (
        <a href={run.prUrl} target="_blank" rel="noreferrer">
          <Pill className="hover:bg-surface-active">
            Pull request
            <ArrowUpRight className="text-muted-foreground" />
          </Pill>
        </a>
      )}
    </span>
  );
}
