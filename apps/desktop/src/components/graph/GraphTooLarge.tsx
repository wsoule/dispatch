import { Notice, Register, RegisterCell, RegisterRow } from '@dispatch/ui';

import styles from './GraphTooLarge.module.css';

/** The too-large state: why the chart is not drawn, and the narrower charts to open. */
export interface GraphTooLargeModel {
  message: string;
  title: string;
  rows: readonly {
    id: string;
    label: string;
    /** The tasks it holds. */
    count: number;
    /** Its own chart (a graph route). */
    href: string;
  }[];
}

/* Past the draw cap: one neutral notice saying how many task cards the chart
   would need and that it draws a fixed number at most (a size limit, not a
   risk, so no status tone), then a heading row and the milestones whose own
   charts to open instead (a register, each row a graph link the shell's link
   provider follows). It stands where the canvas would. */
export function GraphTooLarge({ tooLarge }: { tooLarge: GraphTooLargeModel }) {
  return (
    <section className={styles.tooLarge} aria-label="Too many to draw">
      <Notice label="Too large" tone="default">
        {tooLarge.message}
      </Notice>
      {tooLarge.rows.length > 0 ? (
        <>
          <p className={styles.tooLargeText}>
            <span className={styles.tooLargeTitle}>{tooLarge.title}</span>
          </p>
          <Register
            label={tooLarge.title}
            columns="minmax(0, 1.6fr) minmax(0, 0.5fr)"
            header={[
              { id: 'name', label: 'Milestone' },
              { id: 'count', label: 'Tasks' },
            ]}
            stackWithin={480}
          >
            {tooLarge.rows.map((row) => (
              <RegisterRow
                key={row.id}
                href={row.href}
                rowLabel={`${row.label}: ${row.count} tasks`}
              >
                <RegisterCell label="Milestone" variant="name">
                  {row.label}
                </RegisterCell>
                <RegisterCell label="Tasks" variant="mono">
                  {row.count}
                </RegisterCell>
              </RegisterRow>
            ))}
          </Register>
        </>
      ) : null}
    </section>
  );
}
