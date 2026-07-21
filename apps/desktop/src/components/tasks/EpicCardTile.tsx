import type { EpicProgress } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core';
import { useState } from 'react';

import { priorityTone } from '../../lib/taskDisplay';
import { Button } from '../ui/Button';
import { Pill } from '../ui/Pill';
import './EpicCardTile.css';

interface EpicCardTileProps {
  doc: TaskDoc;
  /** `undefined` while the progress fetch for this epic hasn't resolved yet — the stepper and
   * buttons still render (using `concurrencyDefault`), just without a progress line. */
  progress: EpicProgress | undefined;
  /** Default concurrency for a fresh dispatch session — `orchestrator.epicConcurrency` from the
   * project's config (see TasksPanel), which is itself defaulted to 3 by @dispatch/core. */
  concurrencyDefault: number;
  onSelect: () => void;
  onWork: (epicId: string, concurrency: number) => Promise<void>;
  onStop: (epicId: string) => Promise<void>;
}

/** Board card for a `kind: 'epic'` task: the same id/priority/title header as a plain
 * TaskCardTile (click to open detail), plus the epic-level parallel dispatch controls the plan
 * calls for — a concurrency stepper, "Work this epic" (or "Stop" once a session is active),
 * and a live x/y-done + running-count progress line once the epic has ever been dispatched.
 * A distinct component from TaskCardTile (rather than a kind-branch inside it) because it
 * needs a click target for "open detail" *and* independent interactive controls below it —
 * two nested `<button>`s isn't valid HTML, so this uses a plain clickable header instead. */
export function EpicCardTile({
  doc,
  progress,
  concurrencyDefault,
  onSelect,
  onWork,
  onStop,
}: EpicCardTileProps) {
  const [concurrency, setConcurrency] = useState(concurrencyDefault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tone = priorityTone(doc.meta.priority);
  const active = progress?.active ?? false;

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

  const doneCount =
    progress?.children.filter(
      (c) => c.status === 'done' || c.status === 'cancelled'
    ).length ?? 0;
  const totalCount = progress?.children.length ?? 0;
  const liveCount = progress?.liveRuns.length ?? 0;

  return (
    <div className="epic-card-tile">
      <div
        className="epic-card-tile-header"
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onSelect();
        }}
      >
        <div className="epic-card-tile-top">
          <span className="epic-card-tile-id">{doc.meta.id}</span>
          <Pill variant="tag" tone="accent">
            epic
          </Pill>
          {tone !== null && (
            <Pill variant="tag" tone={tone}>
              {doc.meta.priority}
            </Pill>
          )}
        </div>
        <div className="epic-card-tile-title">{doc.meta.title}</div>
      </div>

      {totalCount > 0 && (
        <div className="epic-card-tile-progress">
          {doneCount}/{totalCount} done
          {liveCount > 0 && ` · ${liveCount} running`}
        </div>
      )}

      {error !== null && <div className="epic-card-tile-error">{error}</div>}

      <div className="epic-card-tile-controls">
        <label className="epic-card-tile-concurrency">
          <span>Concurrency</span>
          <input
            type="number"
            min={1}
            value={concurrency}
            disabled={active || busy}
            onChange={(e) =>
              setConcurrency(Math.max(1, Number(e.target.value) || 1))
            }
            aria-label="Epic dispatch concurrency"
          />
        </label>
        {active ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void run(() => onStop(doc.meta.id))}
          >
            Stop
          </Button>
        ) : (
          <Button
            disabled={busy}
            onClick={() => void run(() => onWork(doc.meta.id, concurrency))}
          >
            Work this epic
          </Button>
        )}
      </div>
    </div>
  );
}
