import {
  MAX_POLICY_RUNG,
  MIN_POLICY_RUNG,
  POLICY_RUNGS,
} from '@dispatch-foo/core/browser';
import { Button, cx } from '@dispatch/ui';
import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';

import styles from './AutonomySlider.module.css';
import { SettingsHint } from './SettingsGroup';

// What each ladder stop means, phrased for the slider. Cumulative on purpose:
// a rung carries every demotion below it (see GATE_RUNGS in core's policy.ts).
const RUNG_DESCRIPTIONS: Record<number, string> = {
  1: 'Every decision waits for you.',
  2: 'Requests to edit extra files are approved for you. Everything else waits.',
  3: 'Extra files and uncertain commands are decided for you, and failed checks go straight back to be fixed. Merging, shared memory and accepted docs still wait.',
  4: "Work that passes its checks merges on its own. You review what happened afterwards. Agents' lessons join shared memory without review. Agents' edits to accepted docs apply without review.",
};

// Short names for the slider's stops, in the page's words rather than core's.
const RUNG_LABELS: Record<number, string> = {
  1: 'Review everything',
  2: 'Allow extra files',
  3: 'Fix on its own',
  4: 'Merge and accept memory and doc edits on their own',
};

interface AutonomySliderProps {
  /** The saved rung the slider sits on. */
  rung: number;
  /** Called once per settled change (pointer release, key release or a stop
   *  click) with the new rung; never for a drag frame or for the saved rung. */
  onRungChange: (rung: number) => void;
}

/** The builder lens's whole policy surface: one range input named "Autonomy"
 *  over the ladder's stops, a button per stop (the chosen one aria-pressed)
 *  and the chosen stop's meaning. Fully controlled from `rung`: a drag or an
 *  arrow key only moves a local draft, and the draft is handed to
 *  `onRungChange` once when the gesture ends. */
export function AutonomySlider({ rung, onRungChange }: AutonomySliderProps) {
  // Local while dragging so a drag across stops saves once, on release.
  const [draft, setDraft] = useState(rung);
  // True while the range has moved since the last commit, so only the release
  // that ends a gesture saves: a modifier key's keyup, a Tab keyup arriving on
  // the input or a click on the track without a move hands out nothing.
  const moved = useRef(false);
  useEffect(() => {
    setDraft(rung);
  }, [rung]);

  const commit = (value: number) => {
    moved.current = false;
    setDraft(value);
    if (value !== rung) onRungChange(value);
  };

  const release = () => {
    if (moved.current) commit(draft);
  };

  const percent =
    ((draft - MIN_POLICY_RUNG) / (MAX_POLICY_RUNG - MIN_POLICY_RUNG)) * 100;
  const active = POLICY_RUNGS.find((stop) => stop.rung === draft);

  return (
    <div className={styles.slider}>
      <input
        type="range"
        aria-label="Autonomy"
        min={MIN_POLICY_RUNG}
        max={MAX_POLICY_RUNG}
        step={1}
        value={draft}
        onChange={(e) => {
          moved.current = true;
          setDraft(Number(e.target.value));
        }}
        onPointerUp={release}
        onKeyUp={release}
        style={{ '--fill': `${String(percent)}%` } as CSSProperties}
        className={styles.range}
      />
      {/* One label per stop, sitting under the stop it names: the first hugs the track's
          left end, the last its right end, the middle ones centre on theirs — a plain
          four-column grid left every label drifting right of its stop. */}
      <div className={styles.stops}>
        {POLICY_RUNGS.map((stop, index) => {
          const edge =
            index === 0
              ? styles.first
              : index === POLICY_RUNGS.length - 1
                ? styles.last
                : undefined;
          return (
            <Button
              key={stop.rung}
              variant="quiet"
              size="sm"
              aria-pressed={stop.rung === draft}
              onClick={() => commit(stop.rung)}
              className={cx(styles.stop, edge)}
            >
              {RUNG_LABELS[stop.rung] ?? stop.label}
            </Button>
          );
        })}
      </div>
      <SettingsHint>{RUNG_DESCRIPTIONS[draft] ?? active?.label}</SettingsHint>
    </div>
  );
}
