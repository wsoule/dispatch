'use client';

import { ChevronRight } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';

import { cx } from '../tasks/class-names';
import styles from './disclosure.module.css';
import type { DisclosureProps } from './types';

/* A button (aria-expanded) over a region shown, and mounted, only while
   open. Controlled with open / onOpenChange or uncontrolled. */
export function Disclosure({
  summary,
  children,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  variant = 'row',
  className,
}: DisclosureProps): ReactNode {
  const [openState, setOpenState] = useState(defaultOpen);
  const isOpen = openProp ?? openState;
  const regionId = useId();

  function toggle(): void {
    const next = !isOpen;
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  }

  const chevron = (
    <ChevronRight
      className={styles.chevron}
      size={14}
      strokeWidth={1.8}
      aria-hidden="true"
    />
  );
  return (
    <div
      className={cx(styles.disclosure, className)}
      data-open={isOpen ? 'true' : undefined}
    >
      <button
        type="button"
        className={cx(styles.summary, styles[variant])}
        aria-expanded={isOpen}
        aria-controls={regionId}
        onClick={toggle}
      >
        {variant === 'row' ? chevron : null}
        <span className={styles.text}>{summary}</span>
        {variant === 'button' ? chevron : null}
      </button>
      <div id={regionId} hidden={!isOpen} className={styles.region}>
        {isOpen ? children : null}
      </div>
    </div>
  );
}
