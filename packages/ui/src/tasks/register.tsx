'use client';

import {
  Children,
  createContext,
  type CSSProperties,
  type FocusEvent,
  isValidElement,
  type KeyboardEvent,
  memo,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { dataAttributes } from '../lib/data-attributes';
import { Link } from '../lib/link';
import { cx } from './class-names';
import styles from './register.module.css';
import type {
  RegisterCellProps,
  RegisterProps,
  RegisterRowProps,
} from './types';
import { type RowWindowGroup, useRowWindows } from './use-row-windows';

/* Container-query classes per stackWithin threshold. */
const WITHIN_CLASS: Record<
  NonNullable<RegisterProps['stackWithin']>,
  string | undefined
> = {
  480: styles.within480,
  600: styles.within600,
  700: styles.within700,
  900: styles.within900,
  1000: styles.within1000,
};

/* ---- row windowing (opt-in: `windowed`) ---------------------------------- */

/** Above this many rows a `windowed` register mounts only the rows near the
    viewport (TaskGroupTable's threshold too). */
const DEFAULT_WINDOW_ABOVE = 150;
/** A row before any is measured: the row's 48px min-height plus the 1px
    divider above it (a row with a sub line is a little taller, and is
    measured on its first draw). */
const REGISTER_ROW_PX = 49;
/** The one list a register windows, as use-row-windows.ts's group id. */
const WINDOW_GROUP = 'register';
/** A register has no sticky header over its rows, and nothing is dragged. */
const NO_HEAD: { readonly current: HTMLElement | null } = { current: null };
const NO_DRAG: ReadonlySet<string> = new Set();
/** The elements Tab stops on inside a row (its stretched link or button,
    and the controls in its cells). */
const TAB_STOPS =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A mounted row's place in a windowed register, handed to its RegisterRow
    (which the host's own row component renders, out of the register's
    reach) so the row's `<li>` carries the id the windows measure it by and
    its position for assistive tech. Null outside a windowing register:
    every register provides it for its own rows, so a register nested in a
    windowed row's span="row" cell never hands its rows the outer place. */
interface RowPlace {
  rowId: string;
  position: number;
  size: number;
}
const RowPlaceContext = createContext<RowPlace | null>(null);

/** One row of a `windowed` register, keyed by its row id whether the
    register windows yet or not, so crossing `windowAbove` (a run arriving,
    a filter typed) adds or removes gaps without remounting any row. The
    place object is kept while the row's position and size stay, so a
    window that moves (or a host render) re-renders no RegisterRow through
    the context; `placed` false (not windowing yet) hands the row none. */
const PlacedRow = memo(function PlacedRow({
  rowId,
  position,
  size,
  placed,
  children,
}: {
  rowId: string;
  position: number;
  size: number;
  placed: boolean;
  children: ReactNode;
}) {
  const place = useMemo(
    () => (placed ? { rowId, position, size } : null),
    [placed, rowId, position, size]
  );
  return (
    <RowPlaceContext.Provider value={place}>
      {children}
    </RowPlaceContext.Provider>
  );
});

// Layout effects do nothing on the server; this keeps React quiet there.
const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The rows' ids: each element's own key, read back from the key
    Children.toArray gave it. toArray writes a keyed child as "$" plus the
    key with "=" escaped as "=0" and ":" as "=2", after a "." (".$run=2r-1"
    for "run:r-1") or, inside a nested array, after its index and a ":"
    (".0:$run=2r-1"); the escape is undone here, so `data-row-id` is the key
    the host wrote. A child with no key keeps React's index key, and so does
    a key two nested arrays both use (the second time), so ids stay unique. */
function rowIdsOf(items: readonly ReactElement[]): string[] {
  const seen = new Set<string>();
  return items.map((element, index) => {
    const key = element.key ?? `.${index}`;
    // Separators are the leading "." and ":" (a key's own ":" is escaped).
    const segment = key.slice(Math.max(key.lastIndexOf(':'), 0) + 1);
    const own = segment.startsWith('$')
      ? segment
          .slice(1)
          .replace(/=[02]/g, (escape) => (escape === '=0' ? '=' : ':'))
      : null;
    const id = own !== null && !seen.has(own) ? own : key;
    seen.add(id);
    return id;
  });
}

/** The Tab stops inside a row, in document order, skipping hidden ones. */
function tabStopsOf(li: Element): HTMLElement[] {
  return Array.from(li.querySelectorAll<HTMLElement>(TAB_STOPS)).filter(
    (el) => el.tabIndex >= 0 && el.closest('[hidden], [inert]') === null
  );
}

/** The row `<li>` of this register's list that holds `el`, if any (a nested
    register's rows inside a span="row" cell do not count). */
function rowItemOf(list: HTMLElement, el: Element): HTMLElement | null {
  for (
    let li = el.closest<HTMLElement>('li[data-row-id]');
    li !== null;
    li = li.parentElement?.closest<HTMLElement>('li[data-row-id]') ?? null
  ) {
    if (li.parentElement === list) return li;
  }
  return null;
}

/** Moves focus where the browser's Tab goes once a list has no stop left
    in that direction: the first Tab stop after the list in document order,
    or going back the last one before it (an ancestor that takes focus
    counts as before). A stop that cannot take focus (not rendered) is
    passed over; with none left focus stays put, as at the page's end. */
function focusBeyond(list: HTMLElement, back: boolean): void {
  const side = back
    ? Node.DOCUMENT_POSITION_PRECEDING
    : Node.DOCUMENT_POSITION_FOLLOWING;
  const beyond = Array.from(
    list.ownerDocument.querySelectorAll<HTMLElement>(TAB_STOPS)
  ).filter(
    (el) =>
      el.tabIndex >= 0 &&
      (list.compareDocumentPosition(el) & side) !== 0 &&
      !list.contains(el) &&
      el.closest('[hidden], [inert]') === null
  );
  if (back) beyond.reverse();
  for (const el of beyond) {
    el.focus();
    if (list.ownerDocument.activeElement === el) return;
  }
}

/* Gr8r's panel table as a layout: one rounded panel of rows sharing one
   grid template (and an optional header row), split by soft dividers.
   Used for Projects, Runs, Settings, the landing page, the graph's lists
   and My week's "Needs attention". Below `stackBelow` (a viewport width)
   or `stackWithin` (the register's own width, through a container query)
   the rows become cards (subject cell on top, the rest on
   `stackedColumns`) and each cell shows its own label, which the header
   otherwise carries (the labels stay readable to assistive tech either
   way, because the header itself is decorative). The host's data-* hooks
   land on the register's root. */
export function Register(props: RegisterProps) {
  const {
    columns,
    header,
    label,
    children,
    stackBelow = 900,
    stackWithin,
    stackedColumns = 'minmax(0, 1fr) minmax(0, 1fr)',
    windowed = false,
    windowAbove = DEFAULT_WINDOW_ABOVE,
    scrollParent,
  } = props;
  const hasHeader = header !== undefined && header.length > 0;
  const stackClass =
    stackWithin === undefined
      ? stackBelow === 700
        ? styles.stack700
        : styles.stack900
      : cx(styles.container, WITHIN_CLASS[stackWithin]);

  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  // A windowed register reads its rows as keyed elements (one per row);
  // any other register hands its children to the list untouched.
  const items = useMemo(
    () => (windowed ? Children.toArray(children).filter(isValidElement) : []),
    [windowed, children]
  );
  const rowIds = useMemo(() => rowIdsOf(items), [items]);
  // The window's one group. A host render with the same rows rebuilds it,
  // which use-row-windows.ts compares by its ids, so the windows stay.
  const groups = useMemo<RowWindowGroup[]>(
    () => (windowed ? [{ id: WINDOW_GROUP, rowIds }] : []),
    [windowed, rowIds]
  );
  const indexOf = useMemo(
    () => new Map(rowIds.map((id, index) => [id, index])),
    [rowIds]
  );
  const enabled = windowed && items.length > windowAbove;

  // The register's own width, while windowed: a change rewraps its rows or
  // (stackWithin) stacks them into cards without a window resize, so the
  // windows forget the old heights and measure again (layoutKey).
  const [width, setWidth] = useState<number | undefined>(undefined);
  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || root === null || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const box = entries.at(-1)?.contentRect;
      if (box !== undefined) setWidth(Math.round(box.width));
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [enabled]);

  const rowWindows = useRowWindows({
    rootRef,
    headRef: NO_HEAD,
    enabled,
    scrollParent,
    groups,
    dragging: NO_DRAG,
    estimate: REGISTER_ROW_PX,
    layoutKey: width,
  });
  const { registerList, setFocusedRow, revealRow } = rowWindows;
  const listRefCallback = useCallback(
    (el: HTMLUListElement | null) => {
      listRef.current = el;
      registerList(WINDOW_GROUP, el);
    },
    [registerList]
  );

  // Which row has focus, for the windows to keep mounted while the list
  // scrolls away from it (focus must never fall to the body). Focus that
  // leaves for another window or app (no related target while the
  // document has lost focus) keeps the pin, since it comes back here.
  function onFocus(event: FocusEvent<HTMLDivElement>) {
    const list = listRef.current;
    if (!enabled || list === null) return;
    const li = rowItemOf(list, event.target as Element);
    setFocusedRow(li?.getAttribute('data-row-id') ?? null);
  }
  function onBlur(event: FocusEvent<HTMLDivElement>) {
    if (!enabled) return;
    const into = event.relatedTarget;
    if (into instanceof Node && event.currentTarget.contains(into)) return;
    if (into === null && !document.hasFocus()) return;
    setFocusedRow(null);
  }

  // Tab out of a row whose neighbour is not mounted (the focused row was
  // kept while the list scrolled away from it) would leave the list across
  // the gap; instead the neighbour is scrolled into view, mounted and
  // given the focus: its first Tab stop going forward, its last going back.
  // The row Tab left keeps the focus, and so the pin, until then.
  const pendingFocus = useRef<{ rowId: string; last: boolean } | null>(null);
  function onListKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    if (event.key !== 'Tab' || event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    const li = rowItemOf(event.currentTarget, target);
    if (li === null) return;
    const back = event.shiftKey;
    const stops = tabStopsOf(li);
    if ((back ? stops[0] : stops.at(-1)) !== target) return;
    const beside = back ? li.previousElementSibling : li.nextElementSibling;
    if (beside === null || !beside.hasAttribute('data-row-gap')) return;
    const index = indexOf.get(li.getAttribute('data-row-id') ?? '');
    if (index === undefined) return;
    const to = back ? index - 1 : index + 1;
    const toId = rowIds[to];
    if (toId === undefined) return;
    event.preventDefault();
    pendingFocus.current = { rowId: toId, last: back };
    revealRow(WINDOW_GROUP, to);
  }
  // The row Tab asked for is focused the moment it is mounted. A row with
  // no Tab stop (a row with no link or button) is passed over, as the
  // browser would: the next mounted rows in the Tab's direction are tried,
  // and past a gap the row behind it is revealed in turn. With no stop left
  // in the list, focus leaves it as the browser's Tab would, so the list
  // never traps the key. The row Tab left stays pinned (it keeps the focus
  // until then), and the pin moves only with the focus.
  useClientLayoutEffect(() => {
    const pending = pendingFocus.current;
    const list = listRef.current;
    if (pending === null || list === null) return;
    const li = list.querySelector<HTMLElement>(
      `:scope > li[data-row-id="${CSS.escape(pending.rowId)}"]`
    );
    if (li === null) return;
    pendingFocus.current = null;
    let last: Element = li;
    for (
      let at: Element | null = li;
      at !== null;
      at = pending.last ? at.previousElementSibling : at.nextElementSibling
    ) {
      const id = at.getAttribute('data-row-id');
      if (id === null) {
        if (!at.hasAttribute('data-row-gap')) continue;
        // A gap: the row behind it is revealed and tried next.
        const index = indexOf.get(last.getAttribute('data-row-id') ?? '');
        const next =
          index === undefined ? undefined : index + (pending.last ? -1 : 1);
        const nextId = next === undefined ? undefined : rowIds[next];
        if (next === undefined || nextId === undefined) break;
        pendingFocus.current = { ...pending, rowId: nextId };
        revealRow(WINDOW_GROUP, next);
        return;
      }
      last = at;
      const stops = tabStopsOf(at);
      const stop = pending.last ? stops.at(-1) : stops[0];
      if (stop !== undefined) {
        setFocusedRow(id);
        stop.focus({ preventScroll: true });
        return;
      }
    }
    // No row in that direction takes focus: on past the list.
    focusBeyond(list, pending.last);
  });

  const segments = enabled ? rowWindows.segmentsOf(WINDOW_GROUP) : null;
  return (
    <div
      {...dataAttributes(props)}
      ref={rootRef}
      className={cx(
        styles.register,
        hasHeader ? styles.hasHeader : undefined,
        stackClass
      )}
      data-stack={
        stackWithin === undefined
          ? `viewport-${stackBelow}`
          : `container-${stackWithin}`
      }
      data-windowed={enabled ? 'true' : undefined}
      style={
        {
          '--register-cols': columns,
          '--register-stacked-cols': stackedColumns,
        } as CSSProperties
      }
      onFocus={enabled ? onFocus : undefined}
      onBlur={enabled ? onBlur : undefined}
    >
      {hasHeader ? (
        <div className={styles.header} aria-hidden="true">
          {header.map((column) => (
            <span
              key={column.id}
              className={cx(
                styles.headerCell,
                column.align === 'end' ? styles.end : undefined
              )}
            >
              {column.label}
            </span>
          ))}
        </div>
      ) : null}
      <ul
        ref={listRefCallback}
        className={styles.list}
        aria-label={label}
        onKeyDown={enabled ? onListKeyDown : undefined}
      >
        {!windowed ? (
          // This register's rows have no place of their own; a register
          // nested in a windowed row must not hand them the outer row's.
          <RowPlaceContext.Provider value={null}>
            {children}
          </RowPlaceContext.Provider>
        ) : segments === null ? (
          // Windowed, at or below windowAbove: every row, keyed by its row
          // id as when windowing, so crossing the threshold remounts none.
          items.map((item, index) => {
            const rowId = rowIds[index] ?? '';
            return (
              <PlacedRow
                key={`row:${rowId}`}
                rowId={rowId}
                position={index + 1}
                size={items.length}
                placed={false}
              >
                {item}
              </PlacedRow>
            );
          })
        ) : (
          // One flat list keyed by row id (and a gap by its first row),
          // so a window that moves keeps every row it still draws.
          segments.flatMap((segment) =>
            segment.kind === 'gap'
              ? [
                  // The rows not mounted: their height, so the scroll
                  // range and every mounted row's place are as if they
                  // were.
                  <li
                    key={`gap:${segment.start}`}
                    className={styles.gap}
                    role="presentation"
                    aria-hidden="true"
                    data-row-gap={segment.end - segment.start}
                    style={{ height: segment.px }}
                  />,
                ]
              : items.slice(segment.start, segment.end).map((item, i) => {
                  const index = segment.start + i;
                  const rowId = rowIds[index] ?? '';
                  return (
                    <PlacedRow
                      key={`row:${rowId}`}
                      rowId={rowId}
                      position={index + 1}
                      size={items.length}
                      placed
                    >
                      {item}
                    </PlacedRow>
                  );
                })
          )
        )}
      </ul>
    </div>
  );
}

/* One register row. With href (or onActivate) the whole row is the target:
   a stretched link/button covers it, is reachable by Tab, and draws the
   focus ring around the row; links inside cells sit above it. Hover and
   focus take the hover fill, a selected row the accent tint with a 2px
   accent bar. The row's tone is data only (data-tone): a row that needs
   action says so with a tinted chip or a toned cell, never a rule (Gr8r);
   muted steps the row's subject back. A button row that is a toggle (a
   filter row) passes `pressed`, which sets aria-pressed on its stretched
   button; `title` is a hover hint over the whole row. The host's data-*
   hooks land on the <li>. */
export function RegisterRow(props: RegisterRowProps) {
  const {
    href,
    external = false,
    onActivate,
    rowLabel,
    pressed,
    tone = 'default',
    selected = false,
    title,
    children,
  } = props;
  const place = useContext(RowPlaceContext);
  const linked = href !== undefined || onActivate !== undefined;
  const name =
    rowLabel !== undefined && external
      ? `${rowLabel} (opens in a new tab)`
      : rowLabel;
  return (
    <li
      {...dataAttributes(props)}
      className={cx(
        styles.row,
        tone === 'muted' ? styles.rowMuted : undefined,
        selected ? styles.selected : undefined,
        linked ? styles.linked : undefined
      )}
      data-tone={tone}
      data-row-id={place?.rowId}
      aria-current={selected ? 'true' : undefined}
      aria-posinset={place?.position}
      aria-setsize={place?.size}
      title={title}
    >
      {href !== undefined ? (
        <Link
          href={href}
          className={styles.overlay}
          aria-label={name}
          target={external ? '_blank' : undefined}
          rel={external ? 'noreferrer noopener' : undefined}
        />
      ) : onActivate !== undefined ? (
        <button
          type="button"
          className={styles.overlay}
          aria-label={name}
          aria-pressed={pressed}
          onClick={onActivate}
        />
      ) : null}
      {children}
    </li>
  );
}

const VARIANT_CLASS: Record<
  NonNullable<RegisterCellProps['variant']>,
  string | undefined
> = {
  name: styles.variantName,
  // The body voice is the cell's own: no class of its own.
  value: undefined,
  mono: styles.variantMono,
};

/* A register cell: an optional label over a value, in one of three
   voices: name (the row's subject, medium weight), value (body copy) or
   mono (short facts: states, counts, dates, in tabular figures; the name
   is historical, the face is Geist). A tone other than default and muted
   colours the value in the tone's text colour (data-tone), and the sub
   line too only when `toneSub` asks (a reason line that is the point);
   muted greys the value. `span="row"` gives the cell the whole row, on its
   own line under the cells before it (an answer-in-place card inside a
   row); its value is a block, so block content stays valid there. The
   host's data-* hooks land on the cell. */
export function RegisterCell(props: RegisterCellProps) {
  const {
    label,
    variant = 'value',
    sub,
    tone = 'default',
    toneSub = false,
    align = 'start',
    span,
    children,
  } = props;
  const toned = tone !== 'default' && tone !== 'muted';
  const spansRow = span === 'row';
  return (
    <div
      {...dataAttributes(props)}
      className={cx(
        styles.cell,
        VARIANT_CLASS[variant],
        toned ? styles.toneText : undefined,
        toned && toneSub ? styles.toneSub : undefined,
        tone === 'muted' ? styles.toneMuted : undefined,
        align === 'end' ? styles.end : undefined,
        spansRow ? styles.spanRow : undefined
      )}
      data-tone={tone}
      data-span={span}
    >
      {label !== undefined && label !== '' ? (
        <span className={styles.cellLabel}>{label}</span>
      ) : null}
      {children !== undefined && children !== null ? (
        spansRow ? (
          <div className={styles.cellValue}>{children}</div>
        ) : (
          <span className={styles.cellValue}>{children}</span>
        )
      ) : null}
      {sub !== undefined && sub !== null ? (
        <span className={styles.cellSub}>{sub}</span>
      ) : null}
    </div>
  );
}
