import type { KeyboardEvent, MouseEvent } from 'react';

// How a clickable row (ListItem, PanelRow) tells its own press from a
// press on a control it holds: a row nests buttons, links and boxes of its
// own, and a press on one of them must not also activate the row.

/* The controls a row may hold: a trailing button, a link in its title, a
   checkbox in its leading slot, a chip's × button. */
const NESTED_CONTROL = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
].join(', ');

/**
 * Whether a click on a row started on a control inside it (not the row
 * itself, nor something around the row): the row leaves that click to
 * the control.
 */
export function fromNestedControl(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const control = target.closest(NESTED_CONTROL);
  return (
    control !== null &&
    control !== event.currentTarget &&
    event.currentTarget.contains(control)
  );
}

/**
 * Whether a keydown activates the row: Enter or Space typed on the row
 * itself (not on a control inside it) and not already handled by the
 * host (event.defaultPrevented).
 */
export function activatesRow(event: KeyboardEvent<HTMLElement>): boolean {
  if (event.defaultPrevented || event.target !== event.currentTarget) {
    return false;
  }
  return event.key === 'Enter' || event.key === ' ';
}
