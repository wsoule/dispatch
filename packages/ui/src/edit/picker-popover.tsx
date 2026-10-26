'use client';

import { Check, Search } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';

import { useMediaQuery, useScrollLock } from '../shell/dom';
import { Kbd } from '../shell/kbd';
import { cx } from '../tasks/class-names';
import { PickerMarkView } from './picker-mark';
import styles from './picker-popover.module.css';
import { placePopover } from './position';
import { useLatest, useSaveControl, valueKey } from './save-state';
import { PendingNote, SaveErrorLine, SavingAnnouncement } from './save-status';
import {
  editLabels,
  filterOptions,
  groupOptions,
  optionMatches,
  queryWords,
  toggleValue,
  withCount,
} from './shared';
import type {
  PickerAppearance,
  PickerOption,
  PickerPopoverProps,
} from './types';

/** Phones get a bottom sheet instead of an anchored popover. */
const SHEET_QUERY = '(max-width: 640px)';
/** Where the pointer may drive the active row (the system's hover gate). */
const HOVER_QUERY = '(hover: hover) and (min-width: 901px)';

// Layout effects do nothing on the server; this keeps React quiet there.
const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

type PickerValue = string | null | readonly string[];

/** A choosable row of the list, in the order the arrow keys walk. */
type Row =
  | { key: 'none'; kind: 'none' }
  | { key: string; kind: 'option'; option: PickerOption }
  | { key: 'retry'; kind: 'retry' };

type CloseReason = 'escape' | 'select' | 'tab' | 'outside' | 'button';

/** How far the trigger's drawn frame reaches outside the button (see the
    ::before rules in the stylesheet): the popover lines up with the frame,
    not the text. */
interface Outset {
  x: number;
  y: number;
}

const OUTSETS: Record<PickerAppearance, Outset> = {
  value: { x: 7, y: 4 },
  mono: { x: 6, y: 4 },
  quiet: { x: 0, y: 0 },
  cell: { x: 7, y: 4 },
  bar: { x: 0, y: 0 },
};

function isList(value: PickerValue): value is readonly string[] {
  return Array.isArray(value);
}

function optionKey(option: PickerOption): string {
  return `o:${option.value}`;
}

/** Puts the popover in the browser's top layer when the Popover API is
    there, so no overflow, transform or z-index of the host can clip or
    cover it; otherwise it stays a fixed layer (see positionLayer). */
function showInTopLayer(layer: HTMLElement): void {
  if (typeof layer.showPopover !== 'function') return;
  try {
    if (!layer.matches(':popover-open')) layer.showPopover();
  } catch {
    // An engine without :popover-open, or a detached node: the fixed
    // fallback still positions it.
  }
}

/**
 * Anchors the open layer to its trigger: measures the panel at its natural
 * (CSS-capped) size, asks placePopover for a side and offsets, and writes
 * them as custom properties the stylesheet reads. Outside the top layer a
 * transformed ancestor makes `position: fixed` relative to that ancestor,
 * so the layer is measured where it landed and corrected by the
 * difference. On a phone the stylesheet draws a bottom sheet and nothing
 * is measured.
 */
function positionLayer(
  layer: HTMLElement,
  anchor: HTMLElement | { x: number; y: number } | null,
  panel: HTMLElement | null,
  sheet: boolean,
  outset: Outset,
  align: 'start' | 'end'
): void {
  const style = layer.style;
  if (sheet || anchor === null || panel === null) {
    layer.dataset.side = 'sheet';
    layer.dataset.placed = 'true';
    return;
  }
  // A trigger lines up by its drawn frame (the outset); a point (a
  // context menu at the pointer) is a box of no size.
  const rect =
    anchor instanceof HTMLElement
      ? (() => {
          const box = anchor.getBoundingClientRect();
          return {
            top: box.top - outset.y,
            bottom: box.bottom + outset.y,
            left: box.left - outset.x,
            right: box.right + outset.x,
          };
        })()
      : { top: anchor.y, bottom: anchor.y, left: anchor.x, right: anchor.x };
  style.setProperty(
    '--picker-anchor-width',
    `${Math.round(rect.right - rect.left)}px`
  );
  style.removeProperty('--picker-max-height');
  const clientWidth = document.documentElement.clientWidth;
  const viewport = {
    width: clientWidth > 0 ? clientWidth : window.innerWidth,
    height: window.innerHeight,
  };
  const placement = placePopover({
    anchor: rect,
    size: { width: panel.offsetWidth, height: panel.offsetHeight },
    viewport,
    align,
  });
  layer.dataset.side = placement.side;
  style.setProperty('--picker-max-height', `${placement.maxHeight}px`);
  style.setProperty('--picker-left', `${placement.left}px`);
  if (placement.top !== null) {
    style.setProperty('--picker-top', `${placement.top}px`);
  }
  if (placement.bottom !== null) {
    style.setProperty('--picker-bottom', `${placement.bottom}px`);
  }
  const landed = layer.getBoundingClientRect();
  if (landed.width > 0 || landed.height > 0) {
    const dx = landed.left - placement.left;
    if (Math.abs(dx) > 0.5) {
      style.setProperty('--picker-left', `${placement.left - dx}px`);
    }
    if (placement.top !== null) {
      const dy = landed.top - placement.top;
      if (Math.abs(dy) > 0.5) {
        style.setProperty('--picker-top', `${placement.top - dy}px`);
      }
    } else if (placement.bottom !== null) {
      const dy = landed.bottom - (viewport.height - placement.bottom);
      if (Math.abs(dy) > 0.5) {
        style.setProperty('--picker-bottom', `${placement.bottom + dy}px`);
      }
    }
  }
  layer.dataset.placed = 'true';
}

/** Moves a list's scroll so `el` is fully visible, without scrolling the
    page (scrollIntoView would also scroll every ancestor). */
function keepInView(scroller: HTMLElement, el: HTMLElement): void {
  const top = el.offsetTop;
  const bottom = top + el.offsetHeight;
  if (top < scroller.scrollTop) scroller.scrollTop = top;
  else if (bottom > scroller.scrollTop + scroller.clientHeight) {
    scroller.scrollTop = bottom - scroller.clientHeight;
  }
}

/**
 * A property picker in the Linear/Gr8r shape: a trigger showing the current
 * value, opening a popover with a search box over a listbox (one choice, or
 * several with `multiple`). Built without a library.
 *
 * Keyboard: Enter, Space or ↓ on the trigger opens it with focus in the
 * search box; typing filters (every word must match the label, hint or
 * keywords); ↑/↓ move the active option; Enter picks it (single: closes;
 * multiple: toggles and stays open); Esc closes and returns focus to the
 * trigger; Tab closes and moves on from the trigger. ARIA: the trigger is a
 * button with aria-haspopup="dialog"; the popover is a non-modal dialog
 * holding a combobox input (aria-activedescendant) that controls the
 * listbox; groups are role="group".
 *
 * Saving: `onChange` may return a promise. The picked value shows at once
 * with a "Saving" note; on rejection it rolls back to `value` and the error
 * prints under the trigger (or in the open popover's foot).
 *
 * Placement: the popover sits in the browser's top layer when available,
 * anchored below the trigger (above it when it does not fit), sliding left
 * at the right edge; at 640px and below it is a full-width bottom sheet.
 *
 * Menus: `searchable={false}` drops the search row, so a short list of
 * actions (Filter, Sort, a row's "…") reads as a menu. The listbox itself
 * then takes focus (aria-activedescendant on it), with the same keys plus
 * Space to pick.
 */
export function PickerPopover(props: PickerPopoverProps): ReactNode {
  const {
    label,
    options,
    placeholder,
    placeholderTone = 'muted',
    searchPlaceholder,
    noneLabel,
    noneMark,
    emptyLabel,
    loading = false,
    error: optionsError = null,
    onRetry,
    query: queryProp,
    onQueryChange,
    filter = true,
    searchable = true,
    appearance = 'value',
    align = 'start',
    anchorPoint = null,
    returnFocus,
    trigger,
    triggerLabel,
    disabled = false,
    open: openProp,
    onOpenChange,
    formatError,
    labels: labelOverrides,
    id,
    className,
  } = props;
  const multiple = props.multiple === true;
  // A multiple picker drawn as one-choice-per-group menu: no squares, the
  // trailing tick instead.
  const boxes = multiple && props.marks !== 'tick';
  const action = props.multiple !== true && props.action === true;
  const labels = editLabels(labelOverrides);

  const baseId = useId();
  const popupId = `${baseId}-popup`;
  const listId = `${baseId}-list`;
  const errorId = `${baseId}-error`;
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const sheet = useMediaQuery(SHEET_QUERY);
  const hoverCapable = useMediaQuery(HOVER_QUERY);
  // The point as two numbers, so a host's new object for the same point
  // does not re-place the open popover.
  const anchorX = anchorPoint?.x ?? null;
  const anchorY = anchorPoint?.y ?? null;

  const [openState, setOpenState] = useState(false);
  const isOpen = !disabled && (openProp ?? openState);
  const [queryState, setQueryState] = useState('');
  // A menu has no search box, so nothing narrows it.
  const query = searchable ? (queryProp ?? queryState) : '';
  // null = automatic: the chosen option when nothing is typed, else the
  // first match. The arrow keys and the pointer make it explicit.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // The arrow keys have been used since the popover opened: on a phone
  // sheet the active row is only drawn then (a tap needs no highlight).
  const [keyboardNav, setKeyboardNav] = useState(false);

  const control = useSaveControl<PickerValue>(
    props.value,
    (next) =>
      props.multiple === true
        ? props.onChange(isList(next) ? [...next] : [])
        : props.onChange(isList(next) ? null : next),
    formatError,
    labels.saveFailed,
    !action
  );
  const shown = control.shown;
  const shownList: readonly string[] = isList(shown) ? shown : [];
  const shownSingle: string | null = isList(shown) ? null : shown;

  useScrollLock(isOpen && sheet);

  // ---- the list ---------------------------------------------------------

  const words = queryWords(query);
  const visible = filter ? filterOptions(options, query) : [...options];
  const groups = groupOptions(visible);
  const showNone =
    noneLabel !== undefined && optionMatches({ label: noneLabel }, words);
  const showRetry =
    optionsError !== null && optionsError !== '' && onRetry !== undefined;

  const rows: Row[] = [];
  if (showNone) rows.push({ key: 'none', kind: 'none' });
  for (const group of groups) {
    for (const option of group.options) {
      if (option.disabled !== true) {
        rows.push({ key: optionKey(option), kind: 'option', option });
      }
    }
  }
  if (showRetry) rows.push({ key: 'retry', kind: 'retry' });
  const rowIndex = new Map(rows.map((row, i) => [row.key, i]));
  const rowId = (key: string): string | undefined => {
    const index = rowIndex.get(key);
    return index === undefined ? undefined : `${baseId}-row-${index}`;
  };

  function isChosen(row: Row): boolean {
    if (row.kind === 'retry' || action) return false;
    if (row.kind === 'none') {
      return multiple ? shownList.length === 0 : shownSingle === null;
    }
    return multiple
      ? shownList.includes(row.option.value)
      : shownSingle === row.option.value;
  }

  function automaticRow(): Row | null {
    if (words.length === 0) {
      const chosen = rows.find((row) => row.kind !== 'retry' && isChosen(row));
      if (chosen !== undefined) return chosen;
    }
    return rows[0] ?? null;
  }
  const activeRow =
    (activeKey === null
      ? undefined
      : rows.find((row) => row.key === activeKey)) ?? automaticRow();
  const activeId = activeRow === null ? undefined : rowId(activeRow.key);

  // ---- open and close ---------------------------------------------------

  function setOpen(next: boolean): void {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
    setActiveKey(null);
    setKeyboardNav(false);
    if (!next && queryProp === undefined) setQueryState('');
  }

  function close(reason: CloseReason): void {
    if (reason === 'tab') {
      // Focus goes back to the trigger before the browser's own Tab step,
      // and the popover is gone from the DOM by then, so Tab moves on from
      // the trigger (and a host's focus trap sees the real neighbours).
      triggerRef.current?.focus({ preventScroll: true });
      flushSync(() => setOpen(false));
      return;
    }
    setOpen(false);
    if (reason !== 'outside') {
      const target = returnFocus?.() ?? triggerRef.current;
      target?.focus({ preventScroll: true });
    }
  }
  const closeRef = useLatest(close);

  // Pointer down anywhere outside the picker closes it (focus goes where
  // the pointer went).
  useEffect(() => {
    if (!isOpen) return undefined;
    function onPointerDown(event: PointerEvent): void {
      const root = rootRef.current;
      if (root === null || !(event.target instanceof Node)) return;
      if (!root.contains(event.target)) closeRef.current('outside');
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () =>
      document.removeEventListener('pointerdown', onPointerDown, true);
  }, [isOpen, closeRef]);

  // Closed while focus was inside (a host closing it, an outside click on
  // a blank area): the focused input is gone, so focus would be lost to
  // <body>. Hand it back to the trigger instead.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !isOpen) {
      const active = document.activeElement;
      if (active === null || active === document.body) {
        triggerRef.current?.focus({ preventScroll: true });
      }
    }
    wasOpen.current = isOpen;
  }, [isOpen]);

  // Placement, top layer and first focus, then follow the trigger while
  // the page scrolls or resizes (and while the trigger itself changes size,
  // e.g. a label added in multiple mode).
  useClientLayoutEffect(() => {
    if (!isOpen) return undefined;
    const layer = layerRef.current;
    if (layer === null) return undefined;
    showInTopLayer(layer);
    let frame = 0;
    const point =
      anchorX === null || anchorY === null ? null : { x: anchorX, y: anchorY };
    const place = (): void => {
      frame = 0;
      positionLayer(
        layer,
        point ?? triggerRef.current,
        panelRef.current,
        sheet,
        OUTSETS[appearance],
        align
      );
    };
    place();
    (searchable ? inputRef.current : listRef.current)?.focus({
      preventScroll: true,
    });
    const schedule = (event?: Event): void => {
      if (event?.target instanceof Node && layer.contains(event.target)) {
        return;
      }
      if (frame === 0) frame = requestAnimationFrame(place);
    };
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => schedule());
    if (triggerRef.current !== null) observer?.observe(triggerRef.current);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
      observer?.disconnect();
    };
  }, [isOpen, sheet, appearance, align, searchable, anchorX, anchorY]);

  useEffect(() => {
    if (!isOpen || activeId === undefined) return;
    const scroller = scrollRef.current;
    const el = document.getElementById(activeId);
    if (scroller !== null && el !== null) keepInView(scroller, el);
  }, [isOpen, activeId]);

  // ---- choosing ---------------------------------------------------------

  function choose(row: Row): void {
    if (row.kind === 'retry') {
      onRetry?.();
      return;
    }
    if (props.multiple === true) {
      const next =
        row.kind === 'none'
          ? []
          : (props.resolveToggle ?? toggleValue)(shownList, row.option.value);
      setActiveKey(row.key);
      if (valueKey(next) !== valueKey(shownList)) void control.save(next);
      return;
    }
    const next = row.kind === 'none' ? null : row.option.value;
    close('select');
    if (action || next !== shownSingle) void control.save(next);
  }

  function move(delta: 1 | -1): void {
    if (rows.length === 0) return;
    const index = activeRow === null ? -1 : rows.indexOf(activeRow);
    const next =
      index < 0
        ? delta > 0
          ? 0
          : rows.length - 1
        : (index + delta + rows.length) % rows.length;
    setActiveKey(rows[next].key);
    setKeyboardNav(true);
  }

  // The search box's keys, and the list's when there is no search box
  // (where Space picks too, as in any menu).
  function onListKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (!searchable && event.key === ' ') {
      event.preventDefault();
      if (activeRow !== null) choose(activeRow);
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'Enter':
        event.preventDefault();
        if (activeRow !== null) choose(activeRow);
        break;
      case 'Tab':
        close('tab');
        break;
      default:
        break;
    }
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!isOpen) setOpen(true);
    }
  }

  function changeQuery(next: string): void {
    if (queryProp === undefined) setQueryState(next);
    onQueryChange?.(next);
    setActiveKey(null);
  }

  // ---- the trigger's face -----------------------------------------------

  const chosenOptions = multiple
    ? options.filter((option) => shownList.includes(option.value))
    : [];
  const current = multiple
    ? undefined
    : options.find((option) => option.value === shownSingle);
  let valueText: string;
  if (multiple) {
    valueText =
      chosenOptions.length > 0
        ? chosenOptions.map((option) => option.label).join(', ')
        : (placeholder ?? noneLabel ?? '');
  } else if (current !== undefined) {
    valueText = current.label;
  } else if (shownSingle !== null) {
    valueText = props.valueLabel ?? shownSingle;
  } else {
    valueText = placeholder ?? noneLabel ?? '';
  }

  const placeholderFace = (
    <span
      className={cx(
        styles.placeholder,
        placeholderTone !== 'default' && placeholderTone !== 'muted'
          ? styles.toned
          : undefined,
        placeholderTone === 'default' ? styles.plain : undefined
      )}
      data-tone={placeholderTone}
    >
      {valueText}
    </span>
  );

  let face: ReactNode;
  if (trigger !== undefined && trigger !== null && trigger !== false) {
    face = trigger;
  } else if (multiple) {
    face =
      chosenOptions.length > 0 ? (
        <span className={styles.tokens}>
          {chosenOptions.map((option) => (
            <span key={option.value} className={styles.token}>
              {option.mark !== undefined ? (
                <PickerMarkView mark={option.mark} />
              ) : null}
              <span className={styles.tokenText} dir="auto">
                {option.label}
              </span>
            </span>
          ))}
        </span>
      ) : (
        placeholderFace
      );
  } else if (current !== undefined) {
    // The shown option's own tone (an Urgent face in red), so a pending
    // value never wears the previous value's colour.
    const tone = current.tone;
    face = (
      <>
        {current.mark !== undefined ? (
          <span className={styles.faceMark}>
            <PickerMarkView mark={current.mark} />
          </span>
        ) : null}
        <span
          className={cx(
            styles.faceText,
            tone !== undefined && tone !== 'default' && tone !== 'muted'
              ? styles.toned
              : undefined
          )}
          data-tone={tone}
          dir="auto"
        >
          {current.label}
        </span>
      </>
    );
  } else if (shownSingle !== null) {
    face = (
      <span className={styles.faceText} dir="auto">
        {valueText}
      </span>
    );
  } else {
    face = (
      <>
        {noneMark !== undefined ? (
          <span className={styles.faceMark}>
            <PickerMarkView mark={noneMark} />
          </span>
        ) : null}
        {placeholderFace}
      </>
    );
  }

  const accessibleName =
    triggerLabel ?? (valueText === '' ? label : `${label}: ${valueText}`);
  const saveError = control.error;

  // ---- rows -------------------------------------------------------------

  function renderRow(row: Row): ReactNode {
    const active = activeRow !== null && activeRow.key === row.key;
    const chosen = isChosen(row);
    let mark: ReactNode = null;
    let text: string;
    let hint: string | undefined;
    if (row.kind === 'none') {
      text = noneLabel ?? '';
      mark = noneMark !== undefined ? <PickerMarkView mark={noneMark} /> : null;
    } else if (row.kind === 'retry') {
      text = labels.retry;
    } else {
      text = row.option.label;
      hint = row.option.hint;
      mark =
        row.option.mark !== undefined ? (
          <PickerMarkView mark={row.option.mark} />
        ) : null;
    }
    return (
      <div
        key={row.key}
        id={rowId(row.key)}
        role="option"
        aria-selected={chosen}
        className={cx(
          styles.option,
          row.kind === 'retry' ? styles.retryRow : undefined
        )}
        data-active={active ? 'true' : undefined}
        data-kind={row.kind}
        onPointerMove={(event) => {
          if (event.pointerType === 'mouse' && hoverCapable && !active) {
            setActiveKey(row.key);
          }
        }}
        // Keep focus in the search box; the click still picks.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(row)}
        // The keyboard works through the search box or the list (↑/↓, ↵,
        // Space on the active row): focus never lands on a row, so this
        // runs only if a host focuses one. It still gives the row its own
        // keyboard path, Enter or Space picking it.
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          choose(row);
        }}
      >
        {boxes && row.kind !== 'retry' ? (
          <span
            className={styles.check}
            aria-hidden="true"
            data-checked={chosen ? 'true' : undefined}
          >
            <svg viewBox="0 0 12 12" focusable="false">
              <path d="M2.6 6.3 5 8.6 9.4 3.6" />
            </svg>
          </span>
        ) : null}
        {row.kind !== 'retry' ? (
          <span className={styles.optionMark}>{mark}</span>
        ) : null}
        <span className={styles.optionLabel} dir="auto">
          {text}
        </span>
        {hint !== undefined && hint !== '' ? (
          <span className={styles.hint}>{hint}</span>
        ) : null}
        {!boxes && chosen ? (
          <Check
            className={styles.tick}
            size={13}
            strokeWidth={1.75}
            aria-hidden="true"
          />
        ) : null}
      </div>
    );
  }

  function renderDisabled(option: PickerOption): ReactNode {
    return (
      <div
        key={optionKey(option)}
        role="option"
        aria-selected={false}
        aria-disabled="true"
        className={cx(styles.option, styles.disabled)}
        onMouseDown={(event) => event.preventDefault()}
      >
        {boxes ? <span className={styles.check} aria-hidden="true" /> : null}
        <span className={styles.optionMark}>
          {option.mark !== undefined ? (
            <PickerMarkView mark={option.mark} />
          ) : null}
        </span>
        <span className={styles.optionLabel} dir="auto">
          {option.label}
        </span>
        {option.hint !== undefined && option.hint !== '' ? (
          <span className={styles.hint}>{option.hint}</span>
        ) : null}
      </div>
    );
  }

  function renderOptions(list: readonly PickerOption[]): ReactNode[] {
    return list.map((option) =>
      option.disabled === true
        ? renderDisabled(option)
        : renderRow({ key: optionKey(option), kind: 'option', option })
    );
  }

  const optionCount = rows.filter((row) => row.kind === 'option').length;
  const nothingToPick =
    !loading && visible.length === 0 && !showNone && !showRetry;
  const announcement = loading
    ? labels.loading
    : nothingToPick
      ? (emptyLabel ?? labels.noMatch)
      : withCount(labels.results, optionCount);

  const popup = isOpen ? (
    <div
      ref={layerRef}
      id={popupId}
      role="dialog"
      aria-label={label}
      popover="manual"
      className={styles.layer}
      data-picker-popup=""
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          close('escape');
        }
      }}
      onPointerDown={(event) => {
        // The phone sheet's scrim (the layer around the panel) closes it.
        if (event.target === event.currentTarget) {
          event.preventDefault();
          close('button');
        }
      }}
    >
      <div
        ref={panelRef}
        className={styles.panel}
        data-searchable={searchable ? undefined : 'false'}
      >
        {searchable ? (
          <div className={styles.searchRow}>
            <Search
              className={styles.searchIcon}
              size={14}
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-label={label}
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeId}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
              className={styles.input}
              placeholder={searchPlaceholder ?? labels.search}
              value={query}
              onChange={(event) => changeQuery(event.target.value)}
              onKeyDown={onListKeyDown}
            />
            <button
              type="button"
              tabIndex={-1}
              className={styles.close}
              aria-label={labels.close}
              onClick={() => close('button')}
            >
              <span className={styles.closeKey}>
                <Kbd>Esc</Kbd>
              </span>
              <span className={styles.closeWord}>{labels.done}</span>
            </button>
          </div>
        ) : null}
        <div ref={scrollRef} className={styles.scroll}>
          <div
            ref={listRef}
            role="listbox"
            id={listId}
            tabIndex={searchable ? undefined : -1}
            aria-activedescendant={searchable ? undefined : activeId}
            onKeyDown={searchable ? undefined : onListKeyDown}
            aria-label={label}
            aria-multiselectable={multiple ? 'true' : undefined}
            aria-busy={loading ? 'true' : undefined}
            className={styles.list}
            data-keyboard={keyboardNav ? 'true' : undefined}
          >
            {showNone ? renderRow({ key: 'none', kind: 'none' }) : null}
            {groups.map((group, gi) =>
              group.heading === null ? (
                renderOptions(group.options)
              ) : (
                <div
                  key={`group:${group.heading}`}
                  role="group"
                  aria-labelledby={`${baseId}-group-${gi}`}
                  className={styles.group}
                >
                  <div className={styles.groupTitle} aria-hidden="true">
                    <span id={`${baseId}-group-${gi}`}>{group.heading}</span>
                  </div>
                  {renderOptions(group.options)}
                </div>
              )
            )}
            {showRetry ? renderRow({ key: 'retry', kind: 'retry' }) : null}
          </div>
          {loading ? (
            <div className={styles.statusRow} data-picker-loading="">
              <span className={styles.loadingBar} aria-hidden="true" />
              <span>{labels.loading}</span>
            </div>
          ) : null}
          {optionsError !== null && optionsError !== '' ? (
            <div className={styles.errorRow}>
              <span className={styles.errorKey}>{labels.error}</span>
              <span className={styles.errorText} dir="auto">
                {optionsError}
              </span>
            </div>
          ) : null}
          {nothingToPick && (optionsError === null || optionsError === '') ? (
            <div className={styles.statusRow} data-picker-empty="">
              {emptyLabel ?? labels.noMatch}
            </div>
          ) : null}
        </div>
        <div className={styles.foot}>
          {control.pending ? (
            <PendingNote text={labels.saving} />
          ) : saveError !== null ? (
            <SaveErrorLine label={labels.notSaved} message={saveError} />
          ) : searchable ? (
            <span className={styles.hints} aria-hidden="true">
              <span>
                <Kbd>↑↓</Kbd> {labels.move}
              </span>
              <span>
                <Kbd>↵</Kbd> {multiple ? labels.toggle : labels.select}
              </span>
            </span>
          ) : null}
          {searchable ? null : (
            // The search row's close button is gone with it; a phone sheet
            // still needs one ("Done").
            <button
              type="button"
              tabIndex={-1}
              className={styles.sheetClose}
              aria-label={labels.close}
              onClick={() => close('button')}
            >
              {labels.done}
            </button>
          )}
        </div>
        <span className="srOnly" role="status">
          {announcement}
        </span>
      </div>
    </div>
  ) : null;

  return (
    <span
      ref={rootRef}
      className={cx(styles.root, className)}
      data-picker=""
      data-open={isOpen ? 'true' : undefined}
    >
      <span className={styles.triggerRow}>
        <button
          ref={triggerRef}
          id={id}
          type="button"
          className={cx(styles.trigger, styles[appearance])}
          aria-label={accessibleName}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-controls={isOpen ? popupId : undefined}
          aria-describedby={!isOpen && saveError !== null ? errorId : undefined}
          disabled={disabled}
          data-appearance={appearance}
          data-pending={control.pending ? 'true' : undefined}
          onClick={() => setOpen(!isOpen)}
          onKeyDown={onTriggerKeyDown}
        >
          <span className={styles.face}>{face}</span>
        </button>
        {control.pending ? <PendingNote text={labels.saving} /> : null}
      </span>
      <SavingAnnouncement
        pending={control.pending}
        text={`${labels.saving} ${label}`}
      />
      {popup}
      {!isOpen && saveError !== null ? (
        <SaveErrorLine
          id={errorId}
          label={labels.notSaved}
          message={saveError}
          className={styles.saveError}
        />
      ) : null}
    </span>
  );
}
