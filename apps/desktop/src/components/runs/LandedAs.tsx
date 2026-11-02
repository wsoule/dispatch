import type { RunMeta } from '@dispatch/client';
import { Button, Chip, cx } from '@dispatch/ui';
import { ArrowUpRight, GitCommitHorizontal, RotateCcw } from 'lucide-react';
import { useState } from 'react';

import {
  landedCommitUrl,
  mergeLadderLabel,
  mergeLadderState,
  releaseLabel,
} from '../../lib/mergeLadder';
import styles from './LandedAs.module.css';

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
  const short = run.mergeCommit?.slice(0, 7);
  // The sha chip: a commit glyph, the short sha in Geist Mono (a machine-read string), and an
  // out-arrow when it links to GitHub. The full sha is the title.
  const sha =
    run.mergeCommit === undefined ? null : (
      <Chip title={run.mergeCommit}>
        <span className={styles.chipBody}>
          <GitCommitHorizontal size={12} strokeWidth={1.8} aria-hidden="true" />
          <span className={styles.sha}>{short}</span>
          {url !== undefined && (
            <ArrowUpRight
              size={12}
              strokeWidth={1.8}
              aria-hidden="true"
              className={styles.out}
            />
          )}
        </span>
      </Chip>
    );
  return (
    <span data-landing={state} className={styles.root}>
      {state !== 'unmerged' &&
        (state === 'merged-local' ? (
          // The split-brain a landing must never be mistaken for: the words in the warning
          // tone's ink (the global .toneText hook), never the hue alone.
          <span className={cx(styles.owed, 'toneText')} data-tone="warning">
            {mergeLadderLabel(run)}
          </span>
        ) : (
          <span>
            {/* The sha is its own chip below, so the sentence stops at the branch. */}
            {state === 'on-origin' && run.mergeCommit !== undefined
              ? `Landed on origin/${run.baseBranch}`
              : mergeLadderLabel(run)}
          </span>
        ))}
      {sha !== null &&
        (url !== undefined ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className={styles.link}
            aria-label={`Open ${short} on GitHub`}
          >
            {sha}
          </a>
        ) : (
          sha
        ))}
      {release !== undefined && (
        <Chip data-release={run.release?.included === true ? 'in' : 'not-yet'}>
          {release}
        </Chip>
      )}
      {state === 'merged-local' && onPublish !== undefined && (
        <Button
          size="sm"
          variant="secondary"
          busy={publishing}
          busyLabel="Pushing…"
          title={`Replay this merge onto origin/${run.baseBranch} and push it`}
          icon={<RotateCcw size={14} strokeWidth={1.8} aria-hidden="true" />}
          onClick={() => {
            setPublishing(true);
            void onPublish(run.id).finally(() => setPublishing(false));
          }}
        >
          Push to origin
        </Button>
      )}
      {run.prUrl !== undefined && (
        <a
          href={run.prUrl}
          target="_blank"
          rel="noreferrer"
          className={styles.link}
        >
          <Chip>
            <span className={styles.chipBody}>
              Pull request
              <ArrowUpRight
                size={12}
                strokeWidth={1.8}
                aria-hidden="true"
                className={styles.out}
              />
            </span>
          </Chip>
        </a>
      )}
    </span>
  );
}
