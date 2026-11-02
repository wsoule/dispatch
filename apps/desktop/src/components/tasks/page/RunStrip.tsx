import type { RunMeta } from '@dispatch/client';
import { Chip, cx, type PickerOption, PickerPopover } from '@dispatch/ui';
import { type ReactNode, useMemo } from 'react';

import { modelLabel } from '../../../lib/models';
import { runKindLabel } from '../../../lib/runKind';
import { isTerminalRunState, runStateLabel } from '../../../lib/runState';
import { formatShortDate } from '../../../lib/taskDates';
import { RunStatePill } from '../../runs/RunStatePill';
import styles from './RunStrip.module.css';
import { formatElapsed, useElapsed } from '@/hooks/useElapsed';

function LiveElapsed({ since }: { since: string }) {
  const label = useElapsed(Date.parse(since));
  return <>{label}</>;
}

/** How long a run took, or has taken so far — ticking while it is live. */
function Duration({ run }: { run: RunMeta }) {
  if (!isTerminalRunState(run.state))
    return <LiveElapsed since={run.createdAt} />;
  const ms = Date.parse(run.updatedAt) - Date.parse(run.createdAt);
  return <>{Number.isNaN(ms) ? '—' : formatElapsed(ms)}</>;
}

/** One vital: the figure in tabular digits on the secondary ink, its word after it in the
 * quiet ink, and the word again as the hover title. */
function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className={styles.stat} title={label}>
      <span className={cx(styles.statValue, 'num')}>{children}</span>
      <span className={styles.statLabel}>{label}</span>
    </span>
  );
}

/** The kind a run is named by after its id, when it only checked the work (review,
 * verify); null for an execute run, the usual kind. */
function kindSuffix(run: RunMeta): string | null {
  return (run.kind ?? 'execute') === 'execute' ? null : runKindLabel(run.kind);
}

/** A run's id in Geist Mono (a machine-read string), with its kind after it when it only
 * checked the work. */
function RunName({ run }: { run: RunMeta }) {
  const kind = kindSuffix(run);
  return (
    <span className={styles.runName}>
      <span className={cx(styles.runId, 'mono')}>{run.id}</span>
      {kind !== null && <span className={styles.runKind}>{kind}</span>}
    </span>
  );
}

/** Which run the Run and Review modes show, when the task has had more than one: plain
 * text for a single run, else one "Run" picker listing every run led by its compact state
 * mark (named by the state, so "the failed one" is findable without opening each run) with
 * its last update. */
function RunPicker({
  runs,
  selected,
  onSelect,
}: {
  runs: RunMeta[];
  selected: RunMeta;
  onSelect: (runId: string) => void;
}) {
  const options = useMemo<PickerOption[]>(
    () =>
      runs.map((r) => {
        const kind = kindSuffix(r);
        return {
          value: r.id,
          label: kind === null ? r.id : `${r.id} ${kind}`,
          hint: formatShortDate(r.updatedAt),
          // The mark is a role="img" named by the state, so the option reads it too.
          mark: { kind: 'node', node: <RunStatePill meta={r} compact /> },
          keywords: [runStateLabel(r.state)],
        };
      }),
    [runs]
  );
  if (runs.length < 2) {
    return (
      <span className={styles.single}>
        <RunName run={selected} />
      </span>
    );
  }
  return (
    <PickerPopover
      label="Run"
      searchable={false}
      appearance="quiet"
      value={selected.id}
      options={options}
      trigger={<RunName run={selected} />}
      onChange={(value) => {
        // Picking a run only switches the view: nothing to save, so no promise.
        if (value !== null) onSelect(value);
      }}
    />
  );
}

/**
 * The run's vitals on one 32px line above the Run and Review modes: its state, who is
 * running it on which model, which run (a picker once there are several), how long it has
 * taken — ticking while live — what it has cost, and its turns. `actions` sits at the
 * right edge (Stop, the review verdict).
 */
export function RunStrip({
  run,
  runs,
  onSelectRun,
  detail,
  actions,
}: {
  run: RunMeta;
  runs: RunMeta[];
  onSelectRun: (runId: string) => void;
  /** One more fact after the vitals (the review's diff size). */
  detail?: ReactNode;
  actions?: ReactNode;
}) {
  const model = modelLabel(run.model);
  return (
    <div data-slot="run-strip" className={styles.strip}>
      <RunStatePill meta={run} />
      <span className={styles.executor}>
        {run.executor}
        {model !== undefined && (
          <span className={styles.model}>
            {' · '}
            {/* A model the catalogue does not name prints its raw id: mono, as any
                machine-read string; a catalogue label ("Opus 5") stays in Geist. */}
            <span className={model === run.model ? 'mono' : undefined}>
              {model}
            </span>
          </span>
        )}
      </span>
      <RunPicker runs={runs} selected={run} onSelect={onSelectRun} />
      <Stat label="elapsed">
        <Duration run={run} />
      </Stat>
      {run.costUsd !== undefined && (
        <Stat label="spent">${run.costUsd.toFixed(2)}</Stat>
      )}
      {run.turns !== undefined && <Stat label="turns">{run.turns}</Stat>}
      {detail}
      {actions !== undefined && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}

/** The files a run has claimed so far — seeded from the task's writes, grown from its
 * worktree — as chips with the path in Geist Mono, the first eight shown. */
export function FilesTouched({ files }: { files: readonly string[] }) {
  if (files.length === 0) return null;
  const shown = files.slice(0, 8);
  return (
    <div
      data-slot="files-touched"
      className={styles.files}
      aria-label="Files touched"
    >
      <span className={styles.filesLabel}>Files</span>
      {shown.map((f) => (
        <Chip key={f} title={f}>
          <span className={cx(styles.path, 'mono')}>{f}</span>
        </Chip>
      ))}
      {files.length > shown.length && (
        <span className={cx(styles.more, 'num')}>
          +{files.length - shown.length} more
        </span>
      )}
    </div>
  );
}
