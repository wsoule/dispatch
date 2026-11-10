'use client';

import { ChevronRight } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';

import { dataAttributes } from '../lib/data-attributes';
import { cx } from './class-names';
import styles from './disclosure.module.css';
import type { DisclosureProps } from './types';

/**
 * Gr8r's fold: a trigger that shows or hides the panel under it ("Details"
 * under an error, a tool call's arguments, "+3 more"). The default trigger
 * is a button with a leading chevron that turns down while open; a
 * `trigger` render prop draws any other button (a chip, a quiet Button, a
 * full-width bar) and spreads the given props on it. Either way the button
 * carries aria-expanded and aria-controls (the panel's id, `id` or a
 * generated one), and the root carries data-open while open.
 *
 * Closed, the panel stays in the DOM, `hidden` (display: none), with its
 * content unmounted, or mounted and hidden with `keepMounted`. Controlled
 * through `open` and `onOpenChange`, or uncontrolled from `defaultOpen`.
 * After a press it opens with a short height and fade, only under
 * prefers-reduced-motion: no-preference; a fold open from the first render
 * does not move.
 */
export function Disclosure(props: DisclosureProps): ReactNode {
  const {
    open: openProp,
    defaultOpen = false,
    onOpenChange,
    summary,
    trigger,
    variant = 'inline',
    chevron = true,
    keepMounted = false,
    id,
    children,
  } = props;
  const generatedId = useId();
  const panelId = id ?? `${generatedId}-panel`;
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  // Pressed at least once: from then on opening animates (see the
  // stylesheet), so nothing moves on page load.
  const [pressed, setPressed] = useState(false);

  function toggle(): void {
    const next = !open;
    if (openProp === undefined) setOpenState(next);
    setPressed(true);
    onOpenChange?.(next);
  }

  const triggerProps = {
    'aria-expanded': open,
    'aria-controls': panelId,
    onClick: toggle,
    type: 'button' as const,
  };

  return (
    <div
      {...dataAttributes(props)}
      className={cx(styles.root, styles[variant])}
      data-open={open ? 'true' : undefined}
      data-variant={variant}
    >
      {trigger !== undefined ? (
        trigger({ open, props: triggerProps })
      ) : (
        <button {...triggerProps} className={styles.trigger}>
          {chevron ? (
            <ChevronRight
              className={styles.chevron}
              size={14}
              strokeWidth={1.8}
              aria-hidden="true"
            />
          ) : null}
          <span className={styles.summary}>
            {typeof summary === 'function' ? summary({ open }) : summary}
          </span>
        </button>
      )}
      <div
        id={panelId}
        className={styles.panel}
        hidden={!open}
        data-motion={pressed ? 'true' : undefined}
      >
        {open || keepMounted ? children : null}
      </div>
    </div>
  );
}
