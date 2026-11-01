'use client';

import { Check, Plus, Search } from 'lucide-react';
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

import { dataAttributes } from '../lib/data-attributes';
import { useMediaQuery, useScrollLock } from '../shell/dom';
import { Kbd } from '../shell/kbd';
import {
  hideFromTopLayer,
  positionLayer,
  SHEET_QUERY,
  showInTopLayer,
  useLayer,
} from '../shell/layer';
import { cx } from '../tasks/class-names';
import { PickerMarkView } from './picker-mark';
import styles from './picker-popover.module.css';
import { useLatest, useSaveControl, valueKey } from './save-state';
import { PendingNote, SaveErrorLine, SavingAnnouncement } from './save-status';
import {
  editLabels,
  filterOptions,
  groupOptions,
  hasLabel,
  optionMatches,
  queryWords,
  toggleValue,
  withCount,
  withQuery,
} from './shared';
import type {
  PickerAppearance,
  PickerOption,
  PickerPopoverProps,
} from './types';

/** Where the pointer may drive the active row (the system's hover gate). */
const HOVER_QUERY = '(hover: hover) and (min-width: 901px)';

/** Letters typed within this long of each other in a menu add up to one
    typeahead search ("mi" finds "Mine"); a longer pause starts over. */
const TYPEAHEAD_MS = 500;

// Layout effects do nothing on the server; this keeps React quiet there.
const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

type PickerValue = string | null | readonly string[];

/** A choosable row of the list, in the order the arrow keys walk. */
type Row =
  | { key: 'none'; kind: 'none' }
  | { key: string; kind: 'option'; option: PickerOption }
  /** onCreate's row: makes a new option from the typed text. */
  | { key: 'create'; kind: 'create'; text: string }
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
  brand: { x: 0, y: 0 },
};

function isList(value: PickerValue): value is readonly string[] {
  return Array.isArray(value);
}

function optionKey(option: PickerOption): string {
  return `o:${option.value}`;
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
 * trigger; Tab closes and moves on from the trigger. An option with an
 * `href` is a link out: picking it closes the popover and loads the URL.
 * ARIA: the trigger is a button with aria-haspopup="dialog"; the popover
 * is a non-modal dialog holding a combobox input (aria-activedescendant)
 * that controls the listbox; groups are role="group".
 *
 * Saving: `onChange` may return a promise. The picked value shows at once
 * with a "Saving" note; on rejection it rolls back to `value` and the error
 * prints under the trigger (or in the open popover's foot).
 *
 * Placement: the popover sits in the browser's top layer when available,
 * anchored below the trigger (above it when it does not fit), sliding left
 * at the right edge; at 640px and below it is a full-width bottom sheet.
 *
 * Creating: with `onCreate`, a new name typed into the search box (no
 * option's label, case aside) is offered as a trailing "Create "<name>""
 * row, reached by the arrow keys like any option; picking it hands the
 * trimmed text to onCreate under the same save contract (see the prop).
 *
 * Menus: `searchable={false}` drops the search row, so a short list of
 * actions (Filter, Sort, a row's "…") reads as a menu. The listbox itself
 * then takes focus (aria-activedescendant on it), with the same keys plus
 * Space to pick, Home / End for the first and last option, and typeahead
 * (letters jump to the next row starting with them). A search box keeps
 * Home / End for its caret while it holds text.
 */
export function PickerPopover(props: PickerPopoverProps): ReactNode {
  const {
    label,
    options,
    placeholder,
    placeholderTone = 'muted',
    searchPlaceholder,
    searchLabel,
    shortcut,
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
    onCreate,
    createLabel,
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
  // A menu's typeahead: the letters typed so far and when the last came.
  const typed = useRef({ text: '', at: 0 });

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

  // onCreate under the same save contract: it changes no value of the
  // picker's own (the host adds the option), so the control only tracks
  // the pending note and the error.
  const createControl = useSaveControl<string>(
    '',
    (text) => onCreate?.(text),
    formatError,
    labels.saveFailed,
    false
  );
  const pending = control.pending || createControl.pending;
  // Each kind of save clears the other's error when it starts.
  const saveError = createControl.error ?? control.error;

  useScrollLock(isOpen && sheet);

  // ---- the list ---------------------------------------------------------

  const words = queryWords(query);
  const visible = filter ? filterOptions(options, query) : [...options];
  const groups = groupOptions(visible);
  const showNone =
    noneLabel !== undefined && optionMatches({ label: noneLabel }, words);
  const showRetry =
    optionsError !== null && optionsError !== '' && onRetry !== undefined;
  // The create row: a new name typed into the search box. An action menu
  // has no value to add it to.
  const createText = query.trim();
  const showCreate =
    onCreate !== undefined &&
    !action &&
    createText !== '' &&
    !hasLabel(
      noneLabel === undefined
        ? options.map((option) => option.label)
        : [noneLabel, ...options.map((option) => option.label)],
      createText
    );
  const createRow: Row | null = showCreate
    ? { key: 'create', kind: 'create', text: createText }
    : null;

  const rows: Row[] = [];
  if (showNone) rows.push({ key: 'none', kind: 'none' });
  for (const group of groups) {
    for (const option of group.options) {
      if (option.disabled !== true) {
        rows.push({ key: optionKey(option), kind: 'option', option });
      }
    }
  }
  if (createRow !== null) rows.push(createRow);
  if (showRetry) rows.push({ key: 'retry', kind: 'retry' });
  const rowIndex = new Map(rows.map((row, i) => [row.key, i]));
  const rowId = (key: string): string | undefined => {
    const index = rowIndex.get(key);
    return index === undefined ? undefined : `${baseId}-row-${index}`;
  };

  function isChosen(row: Row): boolean {
    if (row.kind === 'retry' || row.kind === 'create') return false;
    if (row.kind === 'option' && row.option.href !== undefined) return false;
    if (row.kind === 'option' && row.option.keepOpen === true) return false;
    // An action menu has no value: the host marks the current option.
    if (action) return row.kind === 'option' && row.option.selected === true;
    if (row.kind === 'none') {
      return multiple ? shownList.length === 0 : shownSingle === null;
    }
    return multiple
      ? shownList.includes(row.option.value)
      : shownSingle === row.option.value;
  }

  function automaticRow(): Row | null {
    if (words.length === 0) {
      const chosen = rows.find((row) => isChosen(row));
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
  const queryNow = useLatest(query);
  const openNow = useLatest(isOpen);

  // One layer of the package's stack: a pointer down outside the picker
  // (its trigger counts as inside) closes it, focus going where the
  // pointer went, unless a layer opened over it takes the press; an Escape
  // with focus outside the popover closes it too. Escape from inside is
  // the popover's own handler below.
  useLayer({
    open: isOpen,
    kind: 'popover',
    ref: layerRef,
    inside: () => [rootRef.current],
    onDismiss: (reason) => closeRef.current(reason),
  });

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

  // Into the browser's top layer while open (declared before the placement
  // below, which measures the layer where it landed). Only on open and
  // close: re-showing on every placement would lift it over a layer that
  // was opened inside it later.
  useClientLayoutEffect(() => {
    const layer = layerRef.current;
    if (!isOpen || layer === null) return undefined;
    showInTopLayer(layer);
    return () => hideFromTopLayer(layer);
  }, [isOpen]);

  // Placement and first focus, then follow the trigger while
  // the page scrolls or resizes (and while the trigger itself changes size,
  // e.g. a label added in multiple mode).
  useClientLayoutEffect(() => {
    if (!isOpen) return undefined;
    const layer = layerRef.current;
    if (layer === null) return undefined;
    let frame = 0;
    const point =
      anchorX === null || anchorY === null ? null : { x: anchorX, y: anchorY };
    const place = (): void => {
      frame = 0;
      positionLayer(layer, point ?? triggerRef.current, {
        panel: panelRef.current,
        sheet,
        outset: OUTSETS[appearance],
        align,
        prefix: '--picker',
      });
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
    if (row.kind === 'create') {
      create(row.text);
      return;
    }
    // A link out is followed, never chosen: no save, so no pending note.
    if (row.kind === 'option' && row.option.href !== undefined) {
      const href = row.option.href;
      close('select');
      window.location.assign(href);
      return;
    }
    // A step (a facet, "Back"): the host swaps the options next, so the
    // search and the active row start over and focus stays in the panel.
    // Never through the save contract: a step is not a value, so it shows
    // no pending note and announces no "Saving".
    if (row.kind === 'option' && row.option.keepOpen === true) {
      if (props.multiple === true) {
        void props.onChange(
          (props.resolveToggle ?? toggleValue)(shownList, row.option.value)
        );
      } else {
        void props.onChange(row.option.value);
      }
      changeQuery('');
      setKeyboardNav(false);
      (searchable ? inputRef.current : listRef.current)?.focus({
        preventScroll: true,
      });
      return;
    }
    if (props.multiple === true) {
      const next =
        row.kind === 'none'
          ? []
          : (props.resolveToggle ?? toggleValue)(shownList, row.option.value);
      setActiveKey(row.key);
      if (valueKey(next) !== valueKey(shownList)) {
        createControl.clearError();
        void control.save(next);
      }
      return;
    }
    const next = row.kind === 'none' ? null : row.option.value;
    close('select');
    if (action || next !== shownSingle) {
      createControl.clearError();
      void control.save(next);
    }
  }

  /**
   * The create row picked: hands the typed text to onCreate. A multiple
   * picker clears its search at once, so the next name can be typed while
   * this one saves; a single one stays open with the "Saving" note and
   * closes once the save resolves (if it is still open). A rejection
   * prints the error in the foot and puts the text back in an empty search
   * box. One create at a time: the row does nothing while one is pending.
   */
  function create(text: string): void {
    if (createControl.pending) return;
    control.clearError();
    if (multiple) changeQuery('');
    void createControl.save(text).then((stored) => {
      // Unmounted meanwhile: nothing to close or restore.
      if (rootRef.current === null || !openNow.current) return;
      if (stored) {
        if (!multiple) closeRef.current('select');
        return;
      }
      if (multiple && queryNow.current === '') changeQueryRef.current(text);
    });
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

  /** Makes the first (0) or the last (-1) row active: Home and End. */
  function jump(to: 0 | -1): void {
    const row = to === 0 ? rows[0] : rows[rows.length - 1];
    if (row === undefined) return;
    setActiveKey(row.key);
    setKeyboardNav(true);
  }

  /** The create row's words for the typed text. */
  function createWords(text: string): string {
    return createLabel?.(text) ?? withQuery(labels.create, text);
  }

  function rowText(row: Row): string {
    switch (row.kind) {
      case 'none':
        return noneLabel ?? '';
      case 'retry':
        return labels.retry;
      case 'create':
        return createWords(row.text);
      case 'option':
        return row.option.label;
    }
  }

  /**
   * A menu's typeahead (no search box to type in): each letter adds to a
   * short search over the rows' labels, and the next row starting with it
   * becomes active. The same letter again walks the rows starting with it
   * ("m", "m": Mine, then My open); a pause over TYPEAHEAD_MS starts over.
   * Returns whether a row matched.
   */
  function typeAhead(char: string): boolean {
    const now = Date.now();
    const state = typed.current;
    const text =
      now - state.at > TYPEAHEAD_MS
        ? char.toLowerCase()
        : state.text + char.toLowerCase();
    typed.current = { text, at: now };
    const letters = Array.from(text);
    const repeated = letters.every((letter) => letter === letters[0]);
    const needle = repeated ? (letters[0] ?? '') : text;
    const current = activeRow === null ? -1 : rows.indexOf(activeRow);
    // A new letter moves on from the active row; a longer word may match
    // the active row itself.
    const from = repeated ? current + 1 : Math.max(current, 0);
    for (let step = 0; step < rows.length; step += 1) {
      const row = rows[(from + step) % rows.length];
      if (rowText(row).toLowerCase().startsWith(needle)) {
        setActiveKey(row.key);
        setKeyboardNav(true);
        return true;
      }
    }
    return false;
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
      case 'Home':
      case 'End':
        // A menu's list holds focus, so Home and End are its own; in a
        // search box they move the caret, unless it is empty and the
        // caret has nowhere to go.
        if (searchable && query !== '') break;
        event.preventDefault();
        jump(event.key === 'Home' ? 0 : -1);
        break;
      case 'Enter':
        event.preventDefault();
        if (activeRow !== null) choose(activeRow);
        break;
      case 'Tab':
        close('tab');
        break;
      default:
        if (
          !searchable &&
          event.key.length === 1 &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          typeAhead(event.key)
        ) {
          event.preventDefault();
        }
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
  const changeQueryRef = useLatest(changeQuery);

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
    } else if (row.kind === 'create') {
      text = createWords(row.text);
      mark = <Plus size={14} strokeWidth={1.8} aria-hidden="true" />;
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
        // One create at a time: the row waits while one saves.
        aria-disabled={
          row.kind === 'create' && createControl.pending ? 'true' : undefined
        }
        className={cx(
          styles.option,
          row.kind === 'retry' ? styles.retryRow : undefined,
          row.kind === 'create' ? styles.createRow : undefined
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
        {boxes && row.kind === 'create' ? (
          // No box to tick: the plus lines up with the other rows' marks.
          <span className={styles.checkSpace} aria-hidden="true" />
        ) : boxes && row.kind !== 'retry' ? (
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
    !loading && visible.length === 0 && !showNone && !showRetry && !showCreate;
  // With only the create row left, it says what Enter does.
  const announcement = loading
    ? labels.loading
    : nothingToPick
      ? (emptyLabel ?? labels.noMatch)
      : optionCount === 0 && showCreate
        ? createWords(createText)
        : withCount(labels.results, optionCount);

  const popup = isOpen ? (
    <div
      {...dataAttributes(props)}
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
              aria-label={searchLabel ?? label}
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
            {shortcut !== undefined && shortcut !== '' ? (
              <span className={styles.shortcut} aria-hidden="true">
                <Kbd>{shortcut}</Kbd>
              </span>
            ) : null}
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
                  <div
                    className={cx(
                      styles.groupTitle,
                      group.options[0]?.groupTitleHidden === true
                        ? 'srOnly'
                        : undefined
                    )}
                    aria-hidden="true"
                  >
                    <span id={`${baseId}-group-${gi}`}>{group.heading}</span>
                  </div>
                  {renderOptions(group.options)}
                </div>
              )
            )}
            {createRow !== null ? renderRow(createRow) : null}
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
          {pending ? (
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
      className={cx(
        styles.root,
        appearance === 'brand' ? styles.brandRoot : undefined,
        className
      )}
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
          aria-keyshortcuts={
            shortcut !== undefined && shortcut !== '' ? shortcut : undefined
          }
          disabled={disabled}
          data-appearance={appearance}
          data-pending={pending ? 'true' : undefined}
          onClick={() => setOpen(!isOpen)}
          onKeyDown={onTriggerKeyDown}
        >
          <span className={styles.face}>{face}</span>
        </button>
        {pending ? <PendingNote text={labels.saving} /> : null}
      </span>
      <SavingAnnouncement
        pending={pending}
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
