'use client';

import { Check, ChevronRight } from 'lucide-react';
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

import { placeBeside } from '../edit/position';
import { cx } from '../tasks/class-names';
import {
  showInTopLayer,
  useAnchoredLayer,
  useDismissOutside,
} from './anchored';
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

/** Places a submenu's layer beside the row that opened it. */
function placeSubmenu(layer: HTMLElement, row: HTMLElement): void {
  const rect = row.getBoundingClientRect();
  const width = document.documentElement.clientWidth;
  const placement = placeBeside({
    anchor: rect,
    size: { width: layer.offsetWidth, height: layer.offsetHeight },
    viewport: {
      width: width > 0 ? width : window.innerWidth,
      height: window.innerHeight,
    },
  });
  layer.style.left = `${placement.left}px`;
  layer.style.top = `${placement.top}px`;
  layer.dataset.placed = 'true';
}

interface MenuListProps {
  id: string;
  label: string;
  entries: readonly MenuEntry[];
  firstFocus: FirstFocus;
  /** Closes the whole menu; `refocus` sends focus back to its trigger. */
  onCloseAll: (refocus: boolean) => void;
  /** A submenu's way back to its row (ArrowLeft, Esc); absent at the root. */
  onBack?: () => void;
  emptyLabel?: string;
}

/* One list of rows (the root menu or a submenu) and the submenu it has
   open, if any. The arrow keys move focus over its own enabled rows. */
function MenuList({
  id,
  label,
  entries,
  firstFocus,
  onCloseAll,
  onBack,
  emptyLabel,
}: MenuListProps): ReactNode {
  const menuRef = useRef<HTMLDivElement>(null);
  const [openSub, setOpenSub] = useState<{
    id: string;
    focus: FirstFocus;
  } | null>(null);

  useClientLayoutEffect(() => {
    if (menuRef.current !== null) focusRow(menuRef.current, firstFocus);
  }, [firstFocus]);

  function activate(item: MenuActionItem | MenuRadioItem): void {
    // Focus goes home before the action runs, so an action that opens a
    // dialog captures the trigger as the element to return to.
    onCloseAll(true);
    item.onSelect();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const menu = menuRef.current;
    if (menu === null || event.nativeEvent.isComposing) return;
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
   its first row; ArrowLeft or Esc come back to the row. */
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
  const layerRef = useRef<HTMLDivElement>(null);

  useClientLayoutEffect(() => {
    const layer = layerRef.current;
    const row = rowRef.current;
    if (!open || layer === null || row === null) return;
    showInTopLayer(layer);
    placeSubmenu(layer, row);
  }, [open]);

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
        <div
          ref={layerRef}
          popover="manual"
          className={cx(styles.layer, styles.nested)}
        >
          <MenuList
            id={menuId}
            label={label}
            entries={entry.items}
            firstFocus={focus}
            emptyLabel={entry.emptyLabel}
            onCloseAll={onCloseAll}
            onBack={() => {
              onClose();
              rowRef.current?.focus({ preventScroll: true });
            }}
          />
        </div>
      ) : null}
    </>
  );
}

/* Gr8r's menu opened from a host-rendered button: action, radio, group and
   submenu rows with arrow-key focus; Esc or a press outside closes it. */
export function Menu({
  label,
  items,
  trigger,
  align = 'start',
  open: openProp,
  onOpenChange,
}: MenuProps): ReactNode {
  const [openState, setOpenState] = useState(false);
  const isOpen = openProp ?? openState;
  const [firstFocus, setFirstFocus] = useState<FirstFocus>('menu');
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);

  function setOpen(next: boolean, focus: FirstFocus = 'menu'): void {
    setFirstFocus(focus);
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  }

  function closeAll(refocus: boolean): void {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  }

  useAnchoredLayer(isOpen, layerRef, triggerRef, align);
  useDismissOutside(isOpen, [triggerRef, layerRef], () => setOpen(false));

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
        <div
          ref={layerRef}
          popover="manual"
          className={styles.layer}
          data-picker-popup=""
        >
          <MenuList
            id={menuId}
            label={label}
            entries={items}
            firstFocus={firstFocus}
            onCloseAll={closeAll}
          />
        </div>
      ) : null}
    </>
  );
}
