import type { DiffFile, DiffResult, RunMeta } from '@dispatch/client';
import { PatchDiff } from '@pierre/diffs/react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { useEffect, useMemo, useState } from 'react';

import { normalizeDiffFilePath, toTreeGitStatus } from '../../lib/pierreTree';
import { Button } from '../ui/Button';
import { PierreWorkerPool } from './PierreWorkerPool';
import { RunStatePill } from './RunStatePill';
import './RunReviewView.css';

// The changed-files tree for a run's diff, git-status decorated (added/
// modified/deleted/renamed). A separate component (rather than inlined in
// RunReviewView) because `useFileTree`'s model is constructed once from its
// first-render options — see useFileTree.js's `useState(() => new
// FileTree(options))` — so this only mounts once `files` is known, and
// re-syncs imperatively via `resetPaths`/`setGitStatus` if the diff is ever
// refetched while the view stays open.
function ChangedFilesTree({ files }: { files: DiffFile[] }) {
  const paths = useMemo(
    () => files.map((f) => normalizeDiffFilePath(f.path)),
    [files]
  );
  const gitStatus = useMemo(
    () =>
      files.map((f) => ({
        path: normalizeDiffFilePath(f.path),
        status: toTreeGitStatus(f.status),
      })),
    [files]
  );
  const { model } = useFileTree({
    paths,
    gitStatus,
    initialExpansion: 'open',
  });

  useEffect(() => {
    model.resetPaths(paths);
    model.setGitStatus(gitStatus);
  }, [model, paths, gitStatus]);

  return (
    <FileTree
      model={model}
      header={<span className="run-review-tree-header">Changed files</span>}
      className="run-review-tree"
    />
  );
}

interface RunReviewViewProps {
  meta: RunMeta;
  diff: DiffResult | undefined;
  diffLoading: boolean;
  diffError: string | null;
  onMerge: () => Promise<void>;
  onDiscard: () => Promise<void>;
  onRequestChanges: (text: string) => Promise<void>;
}

/**
 * Review surface for a terminal run (finished/failed/cancelled): the unified diff (@pierre/diffs
 * PatchDiff) alongside a git-status-decorated changed-files tree (@pierre/trees FileTree), with
 * merge / discard / request-changes actions. `diff`/`diffLoading`/`diffError` are owned by the
 * caller (TasksPanel, via `GET /api/runs/:id/diff`) rather than fetched here, matching this
 * codebase's presentational-component convention for the Tasks tab.
 */
export function RunReviewView({
  meta,
  diff,
  diffLoading,
  diffError,
  onMerge,
  onDiscard,
  onRequestChanges,
}: RunReviewViewProps) {
  const [requestingChanges, setRequestingChanges] = useState(false);
  const [changesDraft, setChangesDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitRequestChanges() {
    if (changesDraft.trim() === '') return;
    await run(async () => {
      await onRequestChanges(changesDraft.trim());
      setChangesDraft('');
      setRequestingChanges(false);
    });
  }

  return (
    <div className="run-review-view">
      <div className="run-review-header">
        <RunStatePill state={meta.state} />
        {meta.costUsd !== undefined && (
          <span className="run-review-header-cost">
            ${meta.costUsd.toFixed(2)}
          </span>
        )}
        {meta.error !== undefined && (
          <span className="run-review-header-error-note">{meta.error}</span>
        )}
      </div>

      {error !== null && <div className="run-review-error">{error}</div>}

      {diffLoading && <p className="run-review-status">Loading diff…</p>}
      {diffError !== null && (
        <p className="run-review-status">
          Couldn&rsquo;t load the diff: {diffError}
        </p>
      )}

      {!diffLoading && diffError === null && diff !== undefined && (
        <div className="run-review-body">
          <div className="run-review-tree-pane">
            {diff.files.length === 0 ? (
              <p className="run-review-status">No file changes recorded.</p>
            ) : (
              <ChangedFilesTree files={diff.files} />
            )}
          </div>
          <div className="run-review-diff-pane">
            {diff.patch.trim() === '' ? (
              <p className="run-review-status">
                No changes to show for this run.
              </p>
            ) : (
              <PierreWorkerPool>
                <PatchDiff patch={diff.patch} />
              </PierreWorkerPool>
            )}
          </div>
        </div>
      )}

      {requestingChanges ? (
        <div className="run-review-request-changes">
          <textarea
            className="run-review-request-changes-input"
            rows={3}
            placeholder="Describe what should change…"
            value={changesDraft}
            onChange={(e) => setChangesDraft(e.target.value)}
            autoFocus
          />
          <div className="run-review-request-changes-actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setRequestingChanges(false)}
            >
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void submitRequestChanges()}>
              Send
            </Button>
          </div>
        </div>
      ) : (
        <div className="run-review-actions">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => setRequestingChanges(true)}
          >
            Request changes
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void run(onDiscard)}
          >
            Discard
          </Button>
          <Button disabled={busy} onClick={() => void run(onMerge)}>
            Merge
          </Button>
        </div>
      )}
    </div>
  );
}
