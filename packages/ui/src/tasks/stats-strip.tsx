'use client';

import {
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { dataAttributes } from '../lib/data-attributes';
import { Link } from '../lib/link';
import { useTouchScreen } from '../shell/dom';
import { Tooltip } from '../shell/tooltip';
import { cx } from './class-names';
import styles from './stats-strip.module.css';
import type { StatCell, StatsStripProps } from './types';

// The key, the value and the note. A note in the cell's hint
// (`hinted`) leaves the row but stays in the cell's text for assistive
// tech (srOnly), so a screen reader reading the list still hears it; the
// same <span> either way, so a cell that changes mode keeps its nodes.
function CellBody({
  cell,
  hinted = false,
}: {
  cell: StatCell;
  hinted?: boolean;
}) {
  return (
    <>
      <span className={styles.label}>
        {cell.icon !== undefined && cell.icon !== null ? (
          <span className={styles.icon} aria-hidden="true">
            {cell.icon}
          </span>
        ) : null}
        {cell.label}
      </span>
      <span className={styles.value}>{cell.value}</span>
      {hasNote(cell) ? (
        <span className={hinted ? 'srOnly' : styles.note}>{cell.note}</span>
      ) : null}
    </>
  );
}

function hasNote(cell: StatCell): boolean {
  return cell.note !== undefined && cell.note !== '';
}

/** What the Tooltip clones onto its child, plus the cell's own state. */
interface CellTargetProps {
  ref?: Ref<HTMLDivElement>;
  /** The cell's note is in its hint: a tab stop with the cue. */
  hinted: boolean;
  /** The cell's own element holds focus: it stays focusable once its note
      is back on the row, so the focus is not dropped to <body>. */
  holdsFocus: boolean;
  /** The native hover hint, for a cell whose note is on the row. */
  title: string | undefined;
  /** The id of the hidden title that describes a hinted cell. */
  describedBy: string | undefined;
  /** The Tooltip's tip id while it shows: not used, since a hinted cell's
      note is in its text and its title in its own description (read
      once, not twice). */
  'aria-describedby'?: string;
  onPointerEnter?: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
  onFocus?: (event: FocusEvent<HTMLDivElement>) => void;
  onBlur?: (event: FocusEvent<HTMLDivElement>) => void;
  children: ReactNode;
}

/* A compact cell's inner element, the same <div> whether its note is on
   the row or in its hint, so a strip that changes mode (Flight Plan's when
   a fan-out ends) keeps the node and the focus on it. Hinted, it is a tab
   stop (so the keyboard reaches the hint) with the cue (data-hint), and
   described by its hidden title, not by the tip's id, which exists only
   while the tip shows. Otherwise it is no tab stop and keeps its title as
   the native hover hint; only while it holds focus (a hinted cell Tab
   reached, whose note has just gone back on the row) does it keep
   tabIndex -1, since Chromium drops focus from an element that stops
   being focusable. Any other cell not hinted takes no tabindex, so a
   click on it never focuses the cell, as on any text. It forwards the
   Tooltip's ref and handlers. */
function CellTarget({
  ref,
  hinted,
  holdsFocus,
  title,
  describedBy,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onFocus,
  onBlur,
  children,
}: CellTargetProps) {
  return (
    <div
      ref={ref}
      className={styles.inner}
      data-hint={hinted ? '' : undefined}
      tabIndex={hinted ? 0 : holdsFocus ? -1 : undefined}
      title={hinted ? undefined : title}
      aria-describedby={hinted ? describedBy : undefined}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {children}
    </div>
  );
}

/* A compact, unlinked cell. With `hinting` on (notes="hint" off a touch
   screen) a cell with a note shows only its key and value on the row: the
   note stays in its text for assistive tech, the library Tooltip shows
   the cell's `hint` (else the note, then the title) on hover and keyboard
   focus, and the title is the cell's accessible description. Every other
   cell draws its note inline and keeps its title as the native hover hint,
   in the same elements (CellTarget). */
function CompactCell({ cell, hinting }: { cell: StatCell; hinting: boolean }) {
  const id = `${useId()}-hint`;
  const hinted = hinting && hasNote(cell);
  // Whether the cell's own element has focus (not a control inside it), so
  // it stays focusable if its note goes back on the row (CellTarget).
  const [holdsFocus, setHoldsFocus] = useState(false);
  const title = cell.title ?? '';
  const words =
    cell.hint ?? (title === '' ? (cell.note ?? '') : `${cell.note}. ${title}`);
  const described = hinted && title !== '';
  return (
    <>
      <Tooltip content={words} disabled={!hinted}>
        <CellTarget
          hinted={hinted}
          holdsFocus={holdsFocus}
          title={cell.title}
          describedBy={described ? id : undefined}
          onFocus={(event) => {
            if (event.target === event.currentTarget) setHoldsFocus(true);
          }}
          onBlur={(event) => {
            if (event.target === event.currentTarget) setHoldsFocus(false);
          }}
        >
          <CellBody cell={cell} hinted={hinted} />
        </CellTarget>
      </Tooltip>
      {described ? (
        <span id={id} hidden>
          {title}
        </span>
      ) : null}
    </>
  );
}

// Up to four across. The last cell spans whatever its row leaves empty, so
// the panel has no hole at any count (3 + 2, 4 + 1, ...). Integers are
// computed here rather than with min() inside repeat(), which older WebKit
// (Tauri on macOS) does not resolve.
const MAX_COLUMNS = 4;

function lastCellSpan(count: number, columns: number): number {
  const remainder = count % columns;
  return remainder === 0 ? 1 : columns - remainder + 1;
}

const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Whether a sideways scroller has more than it shows, and on which side. */
interface InlineOverflow {
  /** The content is wider than the box: the box takes a tab stop. */
  overflows: boolean;
  /** Content is hidden before the left edge (scrolled away from the start). */
  before: boolean;
  /** Content is hidden past the right edge. */
  after: boolean;
}

const NO_OVERFLOW: InlineOverflow = {
  overflows: false,
  before: false,
  after: false,
};

// Below a pixel is rounding (a fractional scrollWidth), not hidden content.
const OVERFLOW_SLACK = 1;

// The pixels one wheel "line" moves when a mouse reports lines (Firefox
// with a classic wheel), close to one line of the strip's text.
const WHEEL_LINE_PX = 16;

// How far a cell that takes focus is kept from the scroller's edges: the
// edge fade's width (and the scroller's scroll-padding-inline).
const FADE_PX = 24;

/** Keyboard focus, not a press: :focus-visible where the engine knows it. */
function focusIsVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

/* Scrolls the compact strip just enough that the cell holding `target`
   clears the edge fades. Chromium's own scroll on focus leaves a cell
   that is only partly hidden alone, even when what shows of it is under
   a fade, so a cell reached by Tab (a hinted cell, a link, a control in a
   cell) could take focus out of sight. Only keyboard focus: a press
   focuses the control it lands on at mousedown, and moving the strip then
   would slide the control from under the pointer before mouseup, losing
   the click. Only the scroller moves, never the page around it. */
function revealCell(scroller: HTMLElement, target: Element): void {
  if (!focusIsVisible(target)) return;
  const cell = target.closest('li') ?? target;
  const box = scroller.getBoundingClientRect();
  const rect = cell.getBoundingClientRect();
  if (rect.left < box.left + FADE_PX) {
    scroller.scrollLeft -= box.left + FADE_PX - rect.left;
  } else if (rect.right > box.right - FADE_PX) {
    scroller.scrollLeft += rect.right - (box.right - FADE_PX);
  }
}

/* A plain vertical mouse wheel over a strip that hides cells scrolls it
   sideways, since its scrollbar is hidden and few people know Shift+wheel.
   Only while the strip can still move that way: at either end the wheel is
   left alone, so the page scrolls on as usual. A sideways gesture
   (trackpad, Shift+wheel, a tilt wheel) and a pinch zoom (Ctrl+wheel) are
   the browser's own. Returns whether it took the event. */
function wheelSideways(scroller: HTMLElement, event: WheelEvent): boolean {
  if (event.ctrlKey || event.shiftKey) return false;
  if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return false;
  const max = scroller.scrollWidth - scroller.clientWidth;
  if (max <= OVERFLOW_SLACK) return false;
  const step =
    event.deltaMode === 1
      ? event.deltaY * WHEEL_LINE_PX
      : event.deltaMode === 2
        ? event.deltaY * scroller.clientWidth
        : event.deltaY;
  const left = scroller.scrollLeft;
  if (step < 0 ? left <= OVERFLOW_SLACK : left >= max - OVERFLOW_SLACK) {
    return false;
  }
  scroller.scrollLeft = Math.min(max, Math.max(0, left + step));
  return true;
}

/* Tracks whether the compact strip's scroller is narrower than its cells,
   and which edges hide some of them, so the strip can take a tab stop and
   fade only the edges that have more to show. Measured after layout, on
   every scroll, and whenever the scroller (the column) or the list (the
   cells) changes size, where ResizeObserver exists. While it overflows, a
   vertical mouse wheel over it scrolls it sideways (wheelSideways). State only changes
   when one of the three answers does, so a scroll redraws the strip at
   most at its two ends. Always "fits" on the server and for the panel. */
function useInlineOverflow(
  scrollerRef: RefObject<HTMLDivElement | null>,
  listRef: RefObject<HTMLUListElement | null>,
  enabled: boolean
): InlineOverflow {
  const [overflow, setOverflow] = useState<InlineOverflow>(NO_OVERFLOW);
  useClientLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!enabled || scroller === null) return undefined;
    const measure = () => {
      const max = scroller.scrollWidth - scroller.clientWidth;
      const overflows = max > OVERFLOW_SLACK;
      const left = scroller.scrollLeft;
      const next: InlineOverflow = {
        overflows,
        before: overflows && left > OVERFLOW_SLACK,
        after: overflows && left < max - OVERFLOW_SLACK,
      };
      setOverflow((prev) =>
        prev.overflows === next.overflows &&
        prev.before === next.before &&
        prev.after === next.after
          ? prev
          : next
      );
    };
    measure();
    scroller.addEventListener('scroll', measure, { passive: true });
    // Not passive: a wheel the strip takes must not also scroll the page.
    const onWheel = (event: WheelEvent) => {
      if (wheelSideways(scroller, event)) event.preventDefault();
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(scroller);
    if (listRef.current !== null) observer?.observe(listRef.current);
    return () => {
      scroller.removeEventListener('scroll', measure);
      scroller.removeEventListener('wheel', onWheel);
      observer?.disconnect();
    };
  }, [scrollerRef, listRef, enabled]);
  return enabled ? overflow : NO_OVERFLOW;
}

/* Gr8r's stat strip: one rounded panel split into cells by soft rules,
   each cell a key (after an optional 14px icon), a 22px semibold tabular
   value and a quiet note. The cell's tone (data-tone) colours the value
   and its note: danger for an overdue count, warning for at risk, accent
   for new; default stays --text. Four across, two on phones, with the last
   cell spanning the rest of its row so the panel closes. variant="compact"
   is a header's one-row strip instead: no panel, each cell's key, value
   and note inline on a 26px row between soft rules, and the host's `end`
   controls at the row's end. Cells never wrap: when the column is too
   narrow the list scrolls sideways inside its own box, which then fades
   the edges that hide cells, takes a tab stop as a named group (kept while
   it has focus), scrolls a cell that takes focus clear of the fades
   (revealCell) and turns a vertical mouse wheel sideways (the list's
   data-variant says "compact" to hosts and tests). The controls
   wrap under the strip only when even a 12rem strip leaves them no room.
   The host's data-* hooks land on the list and on each cell's <li>; the
   cell's title is a hover hint on its inner element, not the <li>, so it
   reads as a description and never as the item's name. notes="hint" (compact
   only, and never on a touch screen, where no Tooltip opens) takes each
   unlinked cell's note off the row into a Tooltip on a focusable cell,
   for a header short of room; the note stays in the cell's text for
   assistive tech (CompactCell). The cell's own data-tone wins over a
   host's. */
export function StatsStrip(props: StatsStripProps) {
  const {
    cells,
    label = 'Summary',
    variant = 'panel',
    end,
    notes = 'inline',
  } = props;
  const compact = variant === 'compact';
  const touch = useTouchScreen();
  const hinting = compact && notes === 'hint' && !touch;
  const columns = Math.max(1, Math.min(cells.length, MAX_COLUMNS));
  const span = compact ? 1 : lastCellSpan(cells.length, columns);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const overflow = useInlineOverflow(scrollerRef, listRef, compact);
  // Whether the scroller itself has keyboard focus. Its tab stop stays while
  // it does, even once the cells fit: dropping tabindex from the focused
  // element would send focus to <body> and lose the person's place.
  const [scrollerFocused, setScrollerFocused] = useState(false);
  const stop = overflow.overflows || scrollerFocused;
  const list = (
    <ul
      ref={listRef}
      {...dataAttributes(props)}
      className={cx(styles.strip, compact && styles.compact)}
      // Only when compact, so a panel keeps a host's own data-variant.
      {...(compact ? { 'data-variant': 'compact' } : null)}
      aria-label={label}
      style={
        compact ? undefined : ({ '--stat-cols': columns } as CSSProperties)
      }
    >
      {cells.map((cell, i) => {
        const tone = cell.tone ?? 'default';
        const last = i === cells.length - 1;
        return (
          <li
            key={cell.id}
            {...dataAttributes(cell)}
            className={cx(styles.cell, styles[tone])}
            data-tone={tone}
            style={
              last && span > 1
                ? ({ '--stat-span': span } as CSSProperties)
                : undefined
            }
          >
            {cell.href !== undefined ? (
              <Link
                href={cell.href}
                className={styles.inner}
                title={cell.title}
              >
                <CellBody cell={cell} />
              </Link>
            ) : compact ? (
              <CompactCell cell={cell} hinting={hinting} />
            ) : (
              <div className={styles.inner} title={cell.title}>
                <CellBody cell={cell} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
  if (!compact) return list;
  return (
    <div className={styles.row}>
      <div className={styles.frame}>
        <div
          ref={scrollerRef}
          className={styles.scroller}
          // A tab stop only while the cells overflow (or it holds focus),
          // so a keyboard can scroll them with the arrow keys; then it is a
          // group named after the list, and the frame draws the ring.
          tabIndex={stop ? 0 : undefined}
          role={stop ? 'group' : undefined}
          aria-label={stop ? `${label}, scrolls sideways` : undefined}
          onFocus={(event) => {
            if (event.target === event.currentTarget) setScrollerFocused(true);
            else revealCell(event.currentTarget, event.target);
          }}
          onBlur={(event) => {
            if (event.target === event.currentTarget) setScrollerFocused(false);
          }}
          data-fade-start={overflow.before ? '' : undefined}
          data-fade-end={overflow.after ? '' : undefined}
        >
          {list}
        </div>
      </div>
      {hasEnd(end) ? <div className={styles.end}>{end}</div> : null}
    </div>
  );
}

// Whether the host passed anything to draw at the row's end (false, null
// and undefined draw nothing, as in JSX).
function hasEnd(end: ReactNode): boolean {
  return end !== undefined && end !== null && end !== false;
}
