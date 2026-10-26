'use client';

import {
  type CSSProperties,
  type KeyboardEvent,
  memo,
  type NamedExoticComponent,
  type PointerEvent,
  useRef,
  useState,
} from 'react';

import StatusMark from '../components/status-mark';
import { cx } from '../tasks/class-names';
import {
  addDays,
  centerXForDate,
  daysBetween,
  formatDay,
  formatDayLong,
  maxDay,
  minDay,
  snapDays,
  type TimeScale,
} from './dates';
import { describeMilestone } from './describe';
import { type BarGeometry, MIN_BAR_WIDTH } from './layout';
import styles from './timeline-bar.module.css';

export interface TimelineBarViewProps {
  geometry: BarGeometry;
  scale: TimeScale;
  today: string;
  selected: boolean;
  /** A re-date of this bar is waiting on the host. */
  saving: boolean;
  /** Draws the right-edge handle (the bar is editable and a host can save). */
  editable: boolean;
  onOpen: (barId: string) => void;
  /** A new due date was dropped / entered: the chart saves it. */
  onCommit: (barId: string, newEnd: string) => void;
}

/** The accessible name: label, status, due date, the receipts, and where
 * the window cuts the bar. */
export function barAccessibleName(
  geometry: BarGeometry,
  today: string,
  saving: boolean
): string {
  const parts = describeMilestone(geometry.bar, today);
  if (geometry.clippedStart) parts.push('starts before the window');
  if (geometry.clippedEnd) parts.push('ends after the window');
  if (saving) parts.push('saving');
  return parts.join(', ');
}

type EditMode = 'drag' | 'keys';

/* One milestone bar with its end diamond and, when editable, the re-date
   handle. Memoised: the chart re-renders bars only when the layout changes
   (data, zoom, a committed date), and a drag re-renders only this bar, and
   only when the snapped day changes, never per pointer frame. The pending
   date lives here until it is committed (Enter / drop) or cancelled (Esc,
   blur, pointercancel); the chart then owns the optimistic date. */
function TimelineBarViewImpl({
  geometry,
  scale,
  today,
  selected,
  saving,
  editable,
  onOpen,
  onCommit,
}: TimelineBarViewProps) {
  const { bar } = geometry;
  const [pending, setPending] = useState<string | null>(null);
  const [mode, setMode] = useState<EditMode | null>(null);
  const drag = useRef<{ pointerId: number; originX: number } | null>(null);

  // A due date stays on or after the bar's start and inside the window.
  const minEnd = maxDay(bar.start, scale.windowStart);
  const maxEnd = scale.windowEnd;
  const clamp = (iso: string): string => maxDay(minEnd, minDay(maxEnd, iso));

  const liveEnd = pending ?? bar.end;
  let left = geometry.left;
  let width = geometry.width;
  let endX = geometry.endX;
  if (pending !== null && pending !== bar.end) {
    endX = centerXForDate(pending, scale);
    left = Math.min(left, Math.max(0, endX - MIN_BAR_WIDTH));
    width = Math.max(MIN_BAR_WIDTH, endX - left);
  }
  const delta = pending === null ? 0 : daysBetween(bar.end, pending);

  function cancel() {
    drag.current = null;
    setPending(null);
    setMode(null);
  }

  function finish(next: string) {
    drag.current = null;
    setPending(null);
    setMode(null);
    if (next !== bar.end) onCommit(bar.id, next);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || saving) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    handle.focus({ preventScroll: true });
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best-effort (a synthetic or already-released pointer).
    }
    drag.current = { pointerId: event.pointerId, originX: event.clientX };
    setPending(bar.end);
    setMode('drag');
  }

  function dragTarget(event: PointerEvent<HTMLDivElement>): string | null {
    const active = drag.current;
    if (active === null || active.pointerId !== event.pointerId) return null;
    const days = snapDays(event.clientX - active.originX, scale.dayWidth);
    return clamp(addDays(bar.end, days));
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const next = dragTarget(event);
    // Same-value updates bail out in React: no render until the day changes.
    if (next !== null) setPending(next);
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const next = dragTarget(event);
    if (next === null) return;
    // Cleared before releasing, so the lostpointercapture that follows
    // does not read as a cancel.
    drag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
    finish(next);
  }

  function onPointerCancel() {
    if (drag.current !== null) cancel();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (saving) return;
    const step = event.shiftKey ? 7 : 1;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowLeft': {
        event.preventDefault();
        const sign = event.key === 'ArrowRight' ? 1 : -1;
        setPending(clamp(addDays(liveEnd, sign * step)));
        if (mode === null) setMode('keys');
        return;
      }
      case 'PageUp':
      case 'PageDown': {
        event.preventDefault();
        const sign = event.key === 'PageUp' ? 1 : -1;
        setPending(clamp(addDays(liveEnd, sign * 7)));
        if (mode === null) setMode('keys');
        return;
      }
      // The APG slider's ends: the bar's start and the window's last day.
      case 'Home':
      case 'End':
        event.preventDefault();
        setPending(event.key === 'Home' ? minEnd : maxEnd);
        if (mode === null) setMode('keys');
        return;
      case 'Enter':
        if (pending === null) return;
        event.preventDefault();
        finish(pending);
        return;
      case 'Escape':
        if (pending === null) return;
        // Consumed: a surrounding drawer or dialog must not close on it.
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
      default:
    }
  }

  // Leaving the handle with an uncommitted keyboard change discards it.
  function onBlur() {
    if (mode === 'keys') cancel();
  }

  const status = geometry.laneMuted ? 'muted' : bar.status;
  const name = barAccessibleName(geometry, today, saving);
  // Drawing only: the bar's accessible name already says the status.
  const mark = (
    <span className={styles.mark} aria-hidden="true">
      <StatusMark
        status={bar.status}
        label={bar.statusLabel}
        muted={geometry.laneMuted}
      />
    </span>
  );
  const showTip = pending !== null || saving;
  const diamondX = Math.min(width, endX - left);

  return (
    <div
      className={cx(
        styles.item,
        mode === 'drag' ? styles.dragging : undefined,
        mode !== null ? styles.editing : undefined
      )}
      style={
        {
          left,
          top: geometry.top,
          width,
          '--bar-end': `${left + width}px`,
        } as CSSProperties
      }
      data-bar-id={bar.id}
    >
      <button
        type="button"
        className={cx(
          styles.bar,
          styles[status],
          geometry.point && pending === null ? styles.point : undefined,
          selected ? styles.selected : undefined
        )}
        aria-label={name}
        aria-current={selected ? 'true' : undefined}
        aria-busy={saving ? true : undefined}
        title={`${bar.label} · ${formatDay(bar.start)} → ${formatDay(bar.end)}`}
        onClick={() => onOpen(bar.id)}
      >
        {geometry.labelOutside || geometry.labelHidden ? (
          geometry.clippedStart && !geometry.labelOutside ? (
            <span className={styles.cue} aria-hidden="true">
              ◂
            </span>
          ) : null
        ) : (
          // Sticky inside the bar: when the bar's start scrolls under the
          // lane column, its label slides along so it stays readable. The
          // status mark leads the name (inside the label, so a narrow bar
          // never wraps the name away from it): the status by shape, not
          // only by the bar's hue (WCAG 1.4.1).
          <span className={styles.content}>
            <span className={styles.label}>
              {geometry.clippedStart ? (
                <span className={styles.cue} aria-hidden="true">
                  ◂
                </span>
              ) : null}
              {mark}
              {bar.label}
            </span>
            {bar.progressLabel !== undefined ? (
              <span className={styles.progress}>{bar.progressLabel}</span>
            ) : null}
            {(bar.tags ?? []).map((tag) => (
              <span key={tag} className={styles.tag}>
                {tag}
              </span>
            ))}
            {bar.missing !== undefined ? (
              <span className={styles.missingLine}>{bar.missing}</span>
            ) : null}
          </span>
        )}
        {geometry.clippedEnd ? (
          <span className={cx(styles.cue, styles.cueEnd)} aria-hidden="true">
            ▸
          </span>
        ) : null}
      </button>

      {geometry.clippedEnd ? null : (
        <span
          className={cx(styles.diamond, styles[`d_${status}`])}
          style={{ left: diamondX }}
          data-status={status}
          aria-hidden="true"
        />
      )}

      {geometry.labelOutside ? (
        <span
          className={styles.outside}
          style={{ maxWidth: Math.max(0, geometry.roomAfter - 22) }}
          aria-hidden="true"
        >
          {/* A zero-length bar is its diamond alone, which already has
              the status's shape: no second mark beside it. */}
          {geometry.point ? null : mark}
          <span className={styles.outsideLabel}>{bar.label}</span>
          {bar.progressLabel !== undefined ? (
            <span className={styles.outsideMeta}>{bar.progressLabel}</span>
          ) : null}
          {(bar.tags ?? []).map((tag) => (
            <span key={tag} className={styles.outsideMeta}>
              {tag}
            </span>
          ))}
        </span>
      ) : null}

      {editable ? (
        <div
          role="slider"
          tabIndex={0}
          className={cx(styles.handle, saving ? styles.handleBusy : undefined)}
          style={{ left: diamondX - 6 }}
          aria-label={`Due date of ${bar.label}`}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={Math.round(
            (centerXForDate(maxEnd, scale) - centerXForDate(minEnd, scale)) /
              scale.dayWidth
          )}
          aria-valuenow={Math.round(
            (centerXForDate(liveEnd, scale) - centerXForDate(minEnd, scale)) /
              scale.dayWidth
          )}
          aria-valuetext={`${formatDayLong(liveEnd, today)}${
            pending !== null && pending !== bar.end
              ? ', press Enter to save or Escape to cancel'
              : ''
          }`}
          aria-disabled={saving ? true : undefined}
          aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight PageUp PageDown Home End Enter Escape"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onLostPointerCapture={onPointerCancel}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
        />
      ) : null}

      {showTip ? (
        <span
          className={styles.tip}
          style={{ left: diamondX }}
          aria-hidden="true"
        >
          {formatDay(liveEnd)}
          {saving ? (
            <span className={styles.tipNote}>saving</span>
          ) : delta !== 0 ? (
            <span className={styles.tipNote}>
              {delta > 0 ? `+${delta}d` : `${delta}d`}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

export const TimelineBarView: NamedExoticComponent<TimelineBarViewProps> =
  memo(TimelineBarViewImpl);
