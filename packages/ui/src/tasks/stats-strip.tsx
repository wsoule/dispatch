import type { CSSProperties } from 'react';

import { dataAttributes } from '../lib/data-attributes';
import { Link } from '../lib/link';
import { cx } from './class-names';
import styles from './stats-strip.module.css';
import type { StatCell, StatsStripProps } from './types';

function CellBody({ cell }: { cell: StatCell }) {
  return (
    <>
      <span className={styles.label}>
        {cell.icon !== undefined && cell.icon !== null ? (
          <span className={styles.icon} aria-hidden="true">
            {cell.icon}
          </span>
        ) : null}
        {cell.label}
      </span>
      <span className={styles.value}>{cell.value}</span>
      {cell.note !== undefined && cell.note !== '' ? (
        <span className={styles.note}>{cell.note}</span>
      ) : null}
    </>
  );
}

// Up to four across. The last cell spans whatever its row leaves empty, so
// the panel has no hole at any count (3 + 2, 4 + 1, ...). Integers are
// computed here rather than with min() inside repeat(), which older WebKit
// (Tauri on macOS) does not resolve.
const MAX_COLUMNS = 4;

function lastCellSpan(count: number, columns: number): number {
  const remainder = count % columns;
  return remainder === 0 ? 1 : columns - remainder + 1;
}

/* Gr8r's stat strip: one rounded panel split into cells by soft rules,
   each cell a key (after an optional 14px icon), a 22px semibold tabular
   value and a quiet note. The cell's tone (data-tone) colours the value
   and its note: danger for an overdue count, warning for at risk, accent
   for new; default stays --text. Four across, two on phones, with the last
   cell spanning the rest of its row so the panel closes. variant="compact"
   is a header's one-row strip instead: no panel, each cell's key, value
   and note inline on a 26px row between soft rules, wrapping whole cells
   onto a second row when the column is too narrow (and data-variant on
   the list says so to hosts and tests). The host's data-*
   hooks land on the list and on each cell's <li> (with the cell's title as
   a hover hint); the cell's own data-tone wins over a host's. */
export function StatsStrip(props: StatsStripProps) {
  const { cells, label = 'Summary', variant = 'panel' } = props;
  const compact = variant === 'compact';
  const columns = Math.max(1, Math.min(cells.length, MAX_COLUMNS));
  const span = compact ? 1 : lastCellSpan(cells.length, columns);
  return (
    <ul
      {...dataAttributes(props)}
      className={cx(styles.strip, compact && styles.compact)}
      // Only when compact, so a panel keeps a host's own data-variant.
      {...(compact ? { 'data-variant': 'compact' } : null)}
      aria-label={label}
      style={
        compact ? undefined : ({ '--stat-cols': columns } as CSSProperties)
      }
    >
      {cells.map((cell, i) => {
        const tone = cell.tone ?? 'default';
        const last = i === cells.length - 1;
        return (
          <li
            key={cell.id}
            {...dataAttributes(cell)}
            className={cx(styles.cell, styles[tone])}
            data-tone={tone}
            title={cell.title}
            style={
              last && span > 1
                ? ({ '--stat-span': span } as CSSProperties)
                : undefined
            }
          >
            {cell.href !== undefined ? (
              <Link href={cell.href} className={styles.inner}>
                <CellBody cell={cell} />
              </Link>
            ) : (
              <div className={styles.inner}>
                <CellBody cell={cell} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
