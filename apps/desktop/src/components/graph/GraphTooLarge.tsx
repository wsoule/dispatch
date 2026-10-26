import { Notice, Register, RegisterCell, RegisterRow } from '@dispatch/ui';

import type { GraphTooLarge as GraphTooLargeModel } from '../../adapters/graph';
import styles from './GraphTooLarge.module.css';

/* Past the draw limits: one neutral notice saying how many boxes and arrows
   the graph would need and that it draws at most 700 and 1,000 (a size
   limit, not a risk, so no status tone), then a heading row and the narrower
   graphs to open instead (a register, each row a graph link this view
   follows), or, inside a milestone or a chain, the most connected issues,
   each opening its own chain. It stands where the canvas would. */
export function GraphTooLarge({ tooLarge }: { tooLarge: GraphTooLargeModel }) {
  return (
    <section className={styles.tooLarge} aria-label="Too many to draw">
      <Notice label="Too large" tone="default">
        {tooLarge.message}
      </Notice>
      {tooLarge.rows.length > 0 ? (
        <>
          <p className={styles.tooLargeText}>
            <span className={styles.tooLargeTitle}>
              {tooLarge.title}
              {tooLarge.note !== null ? '.' : ''}
            </span>
            {tooLarge.note !== null ? (
              <>
                {' '}
                <span className={styles.tooLargeNote}>{tooLarge.note}</span>
              </>
            ) : null}
          </p>
          <Register
            label={tooLarge.title}
            columns="minmax(0, 1.6fr) minmax(0, 0.7fr) minmax(0, 0.5fr)"
            header={[
              { id: 'name', label: 'Name' },
              { id: 'kind', label: 'Kind' },
              { id: 'count', label: 'On edges' },
            ]}
            stackWithin={700}
          >
            {tooLarge.rows.map((row) => (
              <RegisterRow
                key={row.id}
                href={row.href}
                rowLabel={`${row.label}: ${row.count} on edges`}
              >
                <RegisterCell label="Name" variant="name">
                  {row.label}
                </RegisterCell>
                <RegisterCell label="Kind" variant="mono">
                  {row.kind}
                </RegisterCell>
                <RegisterCell label="On edges" variant="mono">
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
