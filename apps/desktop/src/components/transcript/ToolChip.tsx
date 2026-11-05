import { cx } from '@dispatch/ui';
import type { LucideIcon } from 'lucide-react';
import { ChevronRight, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { ShimmerLabel } from './ShimmerLabel';
import styles from './transcript.module.css';

export type ToolChipState = 'running' | 'done' | 'failed';

type ToolChipProps = {
  icon: LucideIcon;
  label: string;
  /** A diff stat like `+24 −3`, a command, a filename. */
  meta?: ReactNode;
  state?: ToolChipState;
  /** Makes it a `<button>`; without it the chip is a plain `<span>`. */
  onClick?: () => void;
  /** `chip` is the compact inline pill for wrapping groups; `row` is the flat work-log
   * line: an icon column, the label, the meta, and a chevron when it opens. */
  variant?: 'chip' | 'row';
  /** Row only: draws the trailing chevron, turned down while `expanded`, and (as a
   * button) carries `aria-expanded`. */
  expandable?: boolean;
  /** Whether the details an expandable row opens are showing. */
  expanded?: boolean;
  /** The id of the panel an expandable row opens (a Disclosure's trigger props). */
  'aria-controls'?: string;
  /** The label is a machine-read name (a tool id like `list_runs`), so it takes
   * the mono face (Q5); human words ("Read 3 files") keep the chip's sans. */
  mono?: boolean;
};

/** The tone a call's state is drawn in: a failed call is danger, a running one info, a
 * finished one keeps the neutral face. */
function stateTone(state: ToolChipState): 'danger' | 'info' | undefined {
  switch (state) {
    case 'failed':
      return 'danger';
    case 'running':
      return 'info';
    case 'done':
      return undefined;
  }
}

/** One tool call: icon, label, and an optional `meta` slot. A running call shimmers its
 * label (ShimmerLabel, motion-safe) on the info tint; a failed call takes the danger
 * tint and adds a visible X plus a screen-reader "failed", so colour is never the only
 * cue. Renders a `<button>` when `onClick` is given, a plain `<span>` otherwise. The
 * root carries `data-slot="tool-chip"`, `data-state` and `data-tone` for hosts and
 * tests, since CSS-module class names are not stable hooks. */
export function ToolChip({
  icon: Icon,
  label,
  meta,
  state = 'done',
  onClick,
  variant = 'chip',
  expandable = false,
  expanded = false,
  'aria-controls': ariaControls,
  mono = false,
}: ToolChipProps) {
  const failed = state === 'failed';
  const isRow = variant === 'row';
  const className = cx(
    styles.toolChip,
    isRow ? styles.toolRow : styles.toolPill,
    onClick !== undefined ? styles.toolClickable : undefined
  );
  const content = (
    <>
      <span className={styles.toolIcon}>
        <Icon size={14} strokeWidth={1.8} aria-hidden />
      </span>
      <span className={cx(styles.toolLabel, mono ? 'mono' : undefined)}>
        {state === 'running' ? <ShimmerLabel>{label}</ShimmerLabel> : label}
      </span>
      {meta !== undefined && <span className={styles.toolMeta}>{meta}</span>}
      {failed && (
        <span className={styles.toolFailed}>
          <X size={12} strokeWidth={1.8} aria-hidden />
          <span className="srOnly"> failed</span>
        </span>
      )}
      {isRow && expandable && (
        <ChevronRight
          className={styles.toolChevron}
          size={14}
          strokeWidth={1.8}
          aria-hidden
        />
      )}
    </>
  );
  const hooks = {
    'data-slot': 'tool-chip',
    'data-state': state,
    'data-variant': variant,
    'data-tone': stateTone(state),
    'data-expanded': isRow && expandable && expanded ? 'true' : undefined,
  };

  if (onClick !== undefined) {
    return (
      <button
        {...hooks}
        type="button"
        className={className}
        onClick={onClick}
        aria-expanded={isRow && expandable ? expanded : undefined}
        aria-controls={ariaControls}
      >
        {content}
      </button>
    );
  }
  return (
    <span {...hooks} className={className}>
      {content}
    </span>
  );
}

type ToolChipGroupProps = {
  children: ReactNode;
  /** How many calls are left out; the caller decides how many chips it renders. */
  overflowCount?: number;
};

/** Wraps a row of `ToolChip`s and appends a quiet "+N" overflow chip once the caller has
 * more tool calls than it shows. The count is supplied, not computed. */
export function ToolChipGroup({ children, overflowCount }: ToolChipGroupProps) {
  return (
    <div className={styles.toolGroup}>
      {children}
      {overflowCount !== undefined && overflowCount > 0 && (
        <span className={styles.toolOverflow} data-slot="tool-chip-overflow">
          <span aria-hidden="true">+{overflowCount}</span>
          <span className="srOnly">{`${overflowCount} more tool calls`}</span>
        </span>
      )}
    </div>
  );
}
