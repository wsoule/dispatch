'use client';

import type { CSSProperties } from 'react';

import { Link } from '../lib/link';
import { cx } from './class-names';
import styles from './register.module.css';
import type {
  RegisterCellProps,
  RegisterProps,
  RegisterRowProps,
} from './types';

/* Container-query classes per stackWithin threshold. */
const WITHIN_CLASS: Record<700 | 900 | 1000, string | undefined> = {
  700: styles.within700,
  900: styles.within900,
  1000: styles.within1000,
};

/* Gr8r's panel table as a layout: one rounded panel of rows sharing one
   grid template (and an optional header row), split by soft dividers.
   Used for Projects, Runs, Settings, the landing page, the graph's lists
   and My week's "Needs attention". Below `stackBelow` (a viewport width)
   or `stackWithin` (the register's own width, through a container query)
   the rows become cards (subject cell on top, the rest on
   `stackedColumns`) and each cell shows its own label, which the header
   otherwise carries (the labels stay readable to assistive tech either
   way, because the header itself is decorative). */
export function Register({
  columns,
  header,
  label,
  children,
  stackBelow = 900,
  stackWithin,
  stackedColumns = 'minmax(0, 1fr) minmax(0, 1fr)',
}: RegisterProps) {
  const hasHeader = header !== undefined && header.length > 0;
  const stackClass =
    stackWithin === undefined
      ? stackBelow === 700
        ? styles.stack700
        : styles.stack900
      : cx(styles.container, WITHIN_CLASS[stackWithin]);
  return (
    <div
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
      style={
        {
          '--register-cols': columns,
          '--register-stacked-cols': stackedColumns,
        } as CSSProperties
      }
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
      <ul className={styles.list} aria-label={label}>
        {children}
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
   muted steps the row's subject back. */
export function RegisterRow({
  href,
  external = false,
  onActivate,
  rowLabel,
  tone = 'default',
  selected = false,
  children,
}: RegisterRowProps) {
  const linked = href !== undefined || onActivate !== undefined;
  const name =
    rowLabel !== undefined && external
      ? `${rowLabel} (opens in a new tab)`
      : rowLabel;
  return (
    <li
      className={cx(
        styles.row,
        tone === 'muted' ? styles.rowMuted : undefined,
        selected ? styles.selected : undefined,
        linked ? styles.linked : undefined
      )}
      data-tone={tone}
      aria-current={selected ? 'true' : undefined}
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
   muted greys the value. */
export function RegisterCell({
  label,
  variant = 'value',
  sub,
  tone = 'default',
  toneSub = false,
  align = 'start',
  children,
}: RegisterCellProps) {
  const toned = tone !== 'default' && tone !== 'muted';
  return (
    <div
      className={cx(
        styles.cell,
        VARIANT_CLASS[variant],
        toned ? styles.toneText : undefined,
        toned && toneSub ? styles.toneSub : undefined,
        tone === 'muted' ? styles.toneMuted : undefined,
        align === 'end' ? styles.end : undefined
      )}
      data-tone={tone}
    >
      {label !== undefined && label !== '' ? (
        <span className={styles.cellLabel}>{label}</span>
      ) : null}
      {children !== undefined && children !== null ? (
        <span className={styles.cellValue}>{children}</span>
      ) : null}
      {sub !== undefined && sub !== null ? (
        <span className={styles.cellSub}>{sub}</span>
      ) : null}
    </div>
  );
}
