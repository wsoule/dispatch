'use client';

import { Check, ChevronRight } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';

import { placeBeside } from '../edit/position';
import { dataAttributes } from '../lib/data-attributes';
import {
  followAnchor,
  hideFromTopLayer,
  type LayerDismissReason,
  positionLayer,
  showInTopLayer,
  useLayer,
} from '../shell/layer';
import { cx } from '../tasks/class-names';
import type { DataAttributes } from '../types';
import styles from './menu.module.css';
import type {
  MenuActionItem,
  MenuEntry,
  MenuProps,
  MenuRadioItem,
  MenuSubmenu,
} from './types';

const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Where focus lands when a menu list opens. */
type FirstFocus = 'first' | 'last' | 'menu';

/** The enabled rows of one menu list (not of its submenus), in order. */
function rowsOf(menu: HTMLElement): HTMLElement[] {
  return Array.from(
    menu.querySelectorAll<HTMLElement>('[data-menu-row]:not(:disabled)')
  ).filter((row) => row.closest('[role="menu"]') === menu);
}

/** Focuses a row of `menu`: by position, or the next / previous one. */
function focusRow(menu: HTMLElement, to: FirstFocus | 1 | -1): void {
  const rows = rowsOf(menu);
  if (to === 'menu' || rows.length === 0) {
    menu.focus({ preventScroll: true });
    return;
  }
  let index = to === 'last' ? rows.length - 1 : 0;
  if (to === 1 || to === -1) {
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at === -1) index = to === 1 ? 0 : rows.length - 1;
    else index = (at + to + rows.length) % rows.length;
  }
  rows[index]?.focus({ preventScroll: true });
}

/** The space a submenu keeps clear at the viewport's edges, px. */
const SUBMENU_MARGIN = 8;

/**
 * Places a submenu's layer beside the row that opened it (placeBeside),
 * through the --submenu-left, --submenu-top and --submenu-max-height
 * properties its stylesheet reads: a prefix of its own, because the
 * submenu is a DOM child of the root menu's layer and would otherwise
 * inherit the root's --menu-* values. `list` is measured at its natural
 * size. Outside the top layer a transformed ancestor moves a fixed
 * layer, so it is measured where it landed and corrected, as
 * positionLayer does for the root.
 */
function placeSubmenu(
  layer: HTMLElement,
  list: HTMLElement,
  row: HTMLElement
): void {
  const clientWidth = document.documentElement.clientWidth;
  const viewport = {
    width: clientWidth > 0 ? clientWidth : window.innerWidth,
    height: window.innerHeight,
  };
  const placement = placeBeside({
    anchor: row.getBoundingClientRect(),
    size: { width: list.offsetWidth, height: list.offsetHeight },
    viewport,
    margin: SUBMENU_MARGIN,
  });
  const style = layer.style;
  style.setProperty('--submenu-left', `${placement.left}px`);
  style.setProperty('--submenu-top', `${placement.top}px`);
  style.setProperty(
    '--submenu-max-height',
    `${Math.max(0, viewport.height - 2 * SUBMENU_MARGIN)}px`
  );
  const landed = layer.getBoundingClientRect();
  if (landed.width > 0 || landed.height > 0) {
    const dx = landed.left - placement.left;
    const dy = landed.top - placement.top;
    if (Math.abs(dx) > 0.5) {
      style.setProperty('--submenu-left', `${placement.left - dx}px`);
    }
    if (Math.abs(dy) > 0.5) {
      style.setProperty('--submenu-top', `${placement.top - dy}px`);
    }
  }
  layer.dataset.side = placement.side;
  layer.dataset.placed = 'true';
}

interface MenuListProps {
  id: string;
  label: string;
  entries: readonly MenuEntry[];
  /** The role="menu" element, for the layer that places and focuses it. */
  menuRef: RefObject<HTMLDivElement | null>;
  /** Closes the whole menu; `refocus` sends focus back to its trigger. */
  onCloseAll: (refocus: boolean) => void;
  /** A submenu's way back to its row (ArrowLeft, Esc); absent at the root. */
  onBack?: () => void;
  emptyLabel?: string;
}

/* One list of rows (the root menu or a submenu) and the submenu it has
   open, if any. The arrow keys move focus over its own enabled rows; its
   MenuLayer places it and moves focus into it. */
function MenuList({
  id,
  label,
  entries,
  menuRef,
  onCloseAll,
  onBack,
  emptyLabel,
}: MenuListProps): ReactNode {
  const [openSub, setOpenSub] = useState<{
    id: string;
    focus: FirstFocus;
  } | null>(null);

  function activate(item: MenuActionItem | MenuRadioItem): void {
    // Focus goes home before the action runs, so an action that opens a
    // dialog captures the trigger as the element to return to.
    onCloseAll(true);
    item.onSelect();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const menu = menuRef.current;
    // A key something inside already took (an open submenu's Escape) is
    // not this list's.
    if (
      menu === null ||
      event.nativeEvent.isComposing ||
      event.defaultPrevented
    ) {
      return;
    }
    // Keys inside an open submenu belong to it.
    const inner = (event.target as HTMLElement).closest('[role="menu"]');
    if (inner !== menu) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-menu-row]'
    );
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        focusRow(menu, event.key === 'ArrowDown' ? 1 : -1);
        break;
      case 'Home':
      case 'End':
        event.preventDefault();
        focusRow(menu, event.key === 'Home' ? 'first' : 'last');
        break;
      case 'ArrowRight': {
        const sub = row?.dataset.submenu;
        if (typeof sub === 'string') {
          event.preventDefault();
          setOpenSub({ id: sub, focus: 'first' });
        }
        break;
      }
      case 'ArrowLeft':
        if (onBack !== undefined) {
          event.preventDefault();
          event.stopPropagation();
          onBack();
        }
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        if (onBack !== undefined) onBack();
        else onCloseAll(true);
        break;
      case 'Tab':
        // Focus returns to the trigger first, so Tab moves on from there.
        flushSync(() => onCloseAll(true));
        break;
      default:
        break;
    }
  }

  function renderItem(item: MenuActionItem | MenuRadioItem): ReactNode {
    const radio = item.kind === 'radio' ? item : null;
    const action = item.kind === 'radio' ? null : item;
    return (
      <button
        key={item.id}
        type="button"
        role={radio !== null ? 'menuitemradio' : 'menuitem'}
        aria-checked={radio !== null ? radio.checked : undefined}
        tabIndex={-1}
        disabled={item.disabled}
        title={action?.title}
        className={styles.item}
        data-menu-row=""
        data-destructive={action?.destructive === true ? 'true' : undefined}
        onClick={() => activate(item)}
        onPointerMove={(event) => {
          if (event.pointerType === 'mouse') {
            setOpenSub(null);
            event.currentTarget.focus({ preventScroll: true });
          }
        }}
      >
        <span className={styles.icon} aria-hidden="true">
          {item.icon}
        </span>
        <span className={styles.label}>{item.label}</span>
        {action?.shortcut !== undefined ? (
          <span className={styles.shortcut} aria-hidden="true">
            {action.shortcut}
          </span>
        ) : null}
        {radio !== null && radio.checked ? (
          <Check
            className={styles.tick}
            size={14}
            strokeWidth={2}
            aria-hidden="true"
          />
        ) : null}
      </button>
    );
  }

  function renderSubmenu(entry: MenuSubmenu): ReactNode {
    const subId = `${id}-${entry.id}`;
    const isOpen = openSub?.id === entry.id;
    return (
      <SubmenuRow
        key={entry.id}
        entry={entry}
        menuId={subId}
        open={isOpen}
        focus={openSub?.focus ?? 'menu'}
        onOpen={(focus) => setOpenSub({ id: entry.id, focus })}
        onClose={() => setOpenSub(null)}
        onCloseAll={onCloseAll}
      />
    );
  }

  function renderEntry(entry: MenuEntry, index: number): ReactNode {
    switch (entry.kind) {
      case 'separator':
        return (
          <div
            key={entry.id ?? `separator-${index}`}
            role="separator"
            className={styles.separator}
          />
        );
      case 'group': {
        const headingId = `${id}-${entry.id}-label`;
        return (
          <div
            key={entry.id}
            role="group"
            aria-labelledby={headingId}
            className={styles.group}
          >
            <div id={headingId} className={styles.groupLabel}>
              {entry.label}
            </div>
            {entry.items.map(renderItem)}
          </div>
        );
      }
      case 'submenu':
        return renderSubmenu(entry);
      default:
        return renderItem(entry);
    }
  }

  return (
    <div
      ref={menuRef}
      id={id}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      className={styles.menu}
      onKeyDown={onKeyDown}
    >
      {entries.length === 0 && emptyLabel !== undefined ? (
        <div className={styles.empty}>{emptyLabel}</div>
      ) : (
        entries.map(renderEntry)
      )}
    </div>
  );
}

interface MenuLayerProps extends Omit<MenuListProps, 'menuRef'> {
  /** The trigger (root) or the submenu's row: placed against, and the
      layer's own for presses and focus, so a press on it toggles. */
  anchorRef: { readonly current: HTMLElement | null };
  /** A submenu, placed beside its row instead of under the trigger. */
  nested: boolean;
  align: 'start' | 'end';
  firstFocus: FirstFocus;
  onDismiss: (reason: LayerDismissReason) => void;
  /** The host's data-* hooks (the root menu only). */
  data?: DataAttributes;
}

/*
 * One open menu list as a popover layer of the package's overlay stack
 * (shell/layer.ts), so it nests with Dialog, SlideOver, Popover and the
 * pickers by the stack's rules: Escape closes one layer at a time, a press
 * outside closes it (and only it when the press lands in a layer under
 * it, such as a dialog's body or scrim), and focus moving out closes it.
 * Its effects run in this order, each needing the one before: registered
 * on the stack, shown in the top layer, placed (under its trigger, or
 * beside its row for a submenu) and kept placed while the page scrolls or
 * resizes, and only then focused, because a layer not yet shown cannot
 * take focus. Mounted only while open.
 */
function MenuLayer({
  anchorRef,
  nested,
  align,
  firstFocus,
  onDismiss,
  data,
  ...list
}: MenuLayerProps): ReactNode {
  const layerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayer({
    open: true,
    kind: 'popover',
    ref: layerRef,
    inside: () => [anchorRef.current],
    onDismiss,
  });

  useClientLayoutEffect(() => {
    const layer = layerRef.current;
    if (layer === null) return undefined;
    showInTopLayer(layer);
    return () => hideFromTopLayer(layer);
  }, []);

  useClientLayoutEffect(() => {
    const layer = layerRef.current;
    if (layer === null) return undefined;
    return followAnchor(layer, anchorRef.current, () => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      // A trigger that dropped its ref: the layer stays hidden, unplaced.
      if (anchor === null || menu === null) return;
      if (nested) {
        placeSubmenu(layer, menu, anchor);
      } else {
        positionLayer(layer, anchor, { panel: menu, align, prefix: '--menu' });
      }
    });
  }, [nested, align, anchorRef]);

  useClientLayoutEffect(() => {
    if (menuRef.current !== null) focusRow(menuRef.current, firstFocus);
  }, [firstFocus]);

  return (
    <div
      {...data}
      ref={layerRef}
      popover="manual"
      className={cx(styles.layer, nested ? styles.nested : undefined)}
      data-picker-popup={nested ? undefined : ''}
    >
      <MenuList {...list} menuRef={menuRef} />
    </div>
  );
}

interface SubmenuRowProps {
  entry: MenuSubmenu;
  menuId: string;
  open: boolean;
  focus: FirstFocus;
  onOpen: (focus: FirstFocus) => void;
  onClose: () => void;
  onCloseAll: (refocus: boolean) => void;
}

/* A row opening a nested menu beside it: ArrowRight, Enter or a click focus
   its first row; ArrowLeft or Esc come back to the row. The open submenu
   is a layer of its own, over the root menu's. */
function SubmenuRow({
  entry,
  menuId,
  open,
  focus,
  onOpen,
  onClose,
  onCloseAll,
}: SubmenuRowProps): ReactNode {
  const rowRef = useRef<HTMLButtonElement>(null);

  function back(): void {
    onClose();
    rowRef.current?.focus({ preventScroll: true });
  }

  const label = typeof entry.label === 'string' ? entry.label : entry.id;
  return (
    <>
      <button
        ref={rowRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        tabIndex={-1}
        className={styles.item}
        data-menu-row=""
        data-submenu={entry.id}
        onClick={() => onOpen('first')}
        onPointerMove={(event) => {
          if (event.pointerType !== 'mouse') return;
          event.currentTarget.focus({ preventScroll: true });
          if (!open) onOpen('menu');
        }}
      >
        <span className={styles.icon} aria-hidden="true">
          {entry.icon}
        </span>
        <span className={styles.label}>{entry.label}</span>
        <ChevronRight
          className={styles.chevron}
          size={14}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <MenuLayer
          nested
          align="start"
          anchorRef={rowRef}
          id={menuId}
          label={label}
          entries={entry.items}
          firstFocus={focus}
          emptyLabel={entry.emptyLabel}
          onCloseAll={onCloseAll}
          onBack={back}
          // Escape from outside it (focus on its own row) comes back to
          // the row; a press or focus elsewhere leaves focus there.
          onDismiss={(reason) => {
            if (reason === 'outside') onClose();
            else back();
          }}
        />
      ) : null}
    </>
  );
}

/* Gr8r's menu opened from a host-rendered button: action, radio, group and
   submenu rows with arrow-key focus. The open menu, and each open submenu,
   is a layer of the package's overlay stack: Esc closes the innermost one,
   and a press or focus outside closes it. */
export function Menu(props: MenuProps): ReactNode {
  const {
    label,
    items,
    trigger,
    align = 'start',
    open: openProp,
    onOpenChange,
  } = props;
  const [openState, setOpenState] = useState(false);
  const isOpen = openProp ?? openState;
  const [firstFocus, setFirstFocus] = useState<FirstFocus>('menu');
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  function setOpen(next: boolean, focus: FirstFocus = 'menu'): void {
    setFirstFocus(focus);
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  }

  function closeAll(refocus: boolean): void {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  }

  // Closed by the host while focus was inside: the focused row is gone,
  // so hand focus back to the trigger rather than to <body>.
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

  return (
    <>
      {trigger({
        ref: triggerRef,
        'aria-haspopup': 'menu',
        'aria-expanded': isOpen,
        'aria-controls': isOpen ? menuId : undefined,
        onClick: () => setOpen(!isOpen),
        onKeyDown: (event) => {
          const key = event.key;
          if (key === 'ArrowDown' || key === 'Enter' || key === ' ') {
            event.preventDefault();
            setOpen(true, 'first');
          } else if (key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true, 'last');
          }
        },
      })}
      {isOpen ? (
        <MenuLayer
          nested={false}
          align={align}
          anchorRef={triggerRef}
          id={menuId}
          label={label}
          entries={items}
          firstFocus={firstFocus}
          onCloseAll={closeAll}
          data={dataAttributes(props)}
          // A press or focus outside leaves focus where it went; Escape
          // from outside the menu (focus left on the trigger) closes it
          // and takes focus home.
          onDismiss={(reason) => {
            if (reason === 'outside') setOpen(false);
            else closeAll(true);
          }}
        />
      ) : null}
    </>
  );
}
