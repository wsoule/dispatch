'use client';

import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useRef,
} from 'react';

import { dataAttributes } from '../lib/data-attributes';
import { useMergedRef } from '../lib/refs';
import { cx } from './class-names';
import styles from './list-item.module.css';
import { activatesRow, fromNestedControl } from './row-activation';
import type { ListItemProps } from './types';

/** Whether a slot was given something to draw (0 counts; null, undefined,
    false and '' do not). */
function shown(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== '';
}

/* The trailing slot keeps its clicks to itself, so a chip or a button
   there never activates the row around it. */
function stopClick(event: MouseEvent<HTMLElement>): void {
  event.stopPropagation();
}

/* Of the keys typed on a trailing control, only a plain Enter or Space
   (the control's own press) stays inside the slot, so a host listbox
   around the row never also takes it as a pick. Every other key goes on:
   Escape and Tab still reach a dialog's focus trap and the document's
   Escape listeners, and the app's shortcuts still fire (stopping React's
   event stops the native one at the root too). The row itself already
   ignores keys typed on a control inside it (activatesRow). */
function keepPress(event: KeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
}

/* Gr8r's list row, for a host's own lists (the Overseer's columns and
   inbox, a docked conversation, threads, memories, a stack): 40px, the
   slots in reading order (leading glyph, title with its " › crumb",
   the meta line under them, trailing controls, date), all on tokens.
   Hover is --surface-2, `selected` the accent tint, `active` (a host
   list's keyboard cursor) the focus ring; `unread` an accent dot in the
   left gutter with an sr-only word; `indent` one step in with a
   connector. With `onClick` the row is focusable and Enter or Space on
   the row itself call it with no event; `as="button"` is a native
   button instead, and its trailing controls sit beside it in a wrapper,
   never inside it. The slots carry data-slot hooks and no role. */
export function ListItem(props: ListItemProps) {
  const {
    title,
    leading,
    meta,
    crumb,
    trailing,
    date,
    unread = false,
    selected = false,
    active = false,
    indent = 0,
    as = 'div',
    role,
    domId,
    tabIndex,
    onClick,
    onContextMenu,
    className,
  } = props;
  // One callback ref for whichever element is the row (a div, an li or a
  // button), feeding the host's ref (a Tooltip's anchor among them).
  const own = useRef<HTMLElement | null>(null);
  const setRef = useMergedRef(own, props.ref);
  const isButton = as === 'button';
  const hasTrailing = shown(trailing);
  // A button with trailing controls: the root is a wrapper holding the
  // button and, beside it, the controls (a button inside a button is
  // invalid HTML).
  const split = isButton && hasTrailing;

  // The root's hooks: the host's data-* first, so the slot name and the
  // row's state (which the module draws from) win.
  const rootData = {
    ...dataAttributes(props),
    'data-slot': 'list-item',
    'data-selected': selected ? 'true' : undefined,
    'data-active': active ? 'true' : undefined,
    'data-unread': unread ? 'true' : undefined,
    'data-indent': indent === 1 ? '1' : undefined,
    'data-clickable': onClick !== undefined || isButton ? 'true' : undefined,
  };

  // What the row element takes (the button itself with as="button"): its
  // id, role and name wiring, the press, and what a Tooltip clones on.
  const element = {
    ref: setRef,
    id: domId,
    role,
    'aria-selected': role === 'option' ? selected : undefined,
    'aria-describedby': props['aria-describedby'],
    onClick:
      onClick === undefined
        ? undefined
        : (event: MouseEvent<HTMLElement>) => {
            if (!fromNestedControl(event)) onClick(event);
          },
    onPointerEnter: props.onPointerEnter,
    onPointerLeave: props.onPointerLeave,
    onPointerDown: props.onPointerDown,
    onFocus: props.onFocus,
    onBlur: props.onBlur,
  };

  const connector =
    indent === 1 ? (
      <span
        className={styles.connector}
        data-slot="list-item-connector"
        aria-hidden="true"
      />
    ) : null;
  const body = (
    <>
      {unread ? (
        <span className={styles.unread} data-slot="list-item-unread">
          <span className={styles.unreadDot} aria-hidden="true" />
          <span className="srOnly">Unread, </span>
        </span>
      ) : null}
      {shown(leading) ? (
        <span className={styles.leading} data-slot="list-item-leading">
          {leading}
        </span>
      ) : null}
      <span className={styles.main}>
        <span className={styles.title} data-slot="list-item-title">
          {title}
          {shown(crumb) ? (
            <span className={styles.crumb} data-slot="list-item-crumb">
              {' › '}
              {crumb}
            </span>
          ) : null}
        </span>
        {shown(meta) ? (
          <span className={styles.meta} data-slot="list-item-meta">
            {meta}
          </span>
        ) : null}
      </span>
    </>
  );
  const dateSlot = shown(date) ? (
    <span className={styles.date} data-slot="list-item-date">
      {date}
    </span>
  ) : null;
  const trailingSlot = hasTrailing ? (
    // Not a control of its own: it only keeps its children's clicks and
    // their own presses from reaching the row.
    <span
      className={styles.trailing}
      data-slot="list-item-trailing"
      onClick={stopClick}
      onKeyDown={keepPress}
    >
      {trailing}
    </span>
  ) : null;

  if (isButton) {
    const button = (
      <button
        {...(split ? {} : rootData)}
        {...element}
        type="button"
        tabIndex={tabIndex}
        className={
          split
            ? cx(styles.button, styles.inner)
            : cx(styles.root, styles.button, className)
        }
        onContextMenu={split ? undefined : onContextMenu}
      >
        {split ? null : connector}
        {body}
        {dateSlot}
      </button>
    );
    if (!split) return button;
    return (
      <div
        {...rootData}
        className={cx(styles.root, styles.split, className)}
        onContextMenu={onContextMenu}
      >
        {connector}
        {button}
        {trailingSlot}
      </div>
    );
  }

  const Root = as;
  return (
    <Root
      {...rootData}
      {...element}
      tabIndex={tabIndex ?? (onClick === undefined ? undefined : 0)}
      className={cx(styles.root, className)}
      onContextMenu={onContextMenu}
      onKeyDown={
        onClick === undefined
          ? undefined
          : (event: KeyboardEvent<HTMLElement>) => {
              if (!activatesRow(event)) return;
              event.preventDefault();
              onClick();
            }
      }
    >
      {connector}
      {body}
      {trailingSlot}
      {dateSlot}
    </Root>
  );
}
