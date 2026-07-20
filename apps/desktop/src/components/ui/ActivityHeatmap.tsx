import { useMemo } from 'react';

import type { DailyActivity } from '../../lib/types';
import './ActivityHeatmap.css';

interface ActivityHeatmapProps {
  /** Oldest first, one entry per calendar day, no gaps. */
  data: DailyActivity[];
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

type Cell = { date: string; count: number; level: 0 | 1 | 2 | 3 | 4 } | null;

/** `YYYY-MM-DD` parsed as UTC midnight so day-of-week/month math never drifts with the
 * viewer's local timezone — the backend already buckets by UTC calendar day. */
function parseUtcDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDisplayDate(date: string): string {
  return parseUtcDate(date).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Buckets raw counts into 5 levels (0 = no activity) using quartiles of the non-zero
 * counts, so the ramp adapts to each user's actual activity range instead of hardcoded
 * absolute thresholds — a light user's "busy day" should still read as the darkest cell. */
function levelFor(count: number, sortedNonZero: number[]): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || sortedNonZero.length === 0) return 0;
  const q = (p: number) =>
    sortedNonZero[
      Math.min(sortedNonZero.length - 1, Math.floor(p * sortedNonZero.length))
    ];
  if (count <= q(0.25)) return 1;
  if (count <= q(0.5)) return 2;
  if (count <= q(0.75)) return 3;
  return 4;
}

/**
 * GitHub-style commit heatmap: one column per week, one cell per day (Sun top → Sat
 * bottom), colored on a single-hue sequential ramp (`--accent`, light→dark) since this
 * encodes magnitude, not category. Leading cells before the first real day and trailing
 * cells after the last are rendered as empty spacers so every column is a full week.
 */
export function ActivityHeatmap({ data }: ActivityHeatmapProps) {
  const { weeks, monthMarkers, totalActive } = useMemo(() => {
    const nonZero = data
      .map((d) => d.count)
      .filter((c) => c > 0)
      .sort((a, b) => a - b);

    const cells: Cell[] = data.map((d) => ({
      date: d.date,
      count: d.count,
      level: levelFor(d.count, nonZero),
    }));

    if (cells.length > 0) {
      const leadingPad = parseUtcDate(cells[0].date).getUTCDay();
      for (let i = 0; i < leadingPad; i++) cells.unshift(null);
      const trailingPad = (7 - (cells.length % 7)) % 7;
      for (let i = 0; i < trailingPad; i++) cells.push(null);
    }

    const weeks: Cell[][] = [];
    for (let i = 0; i < cells.length; i += 7) {
      weeks.push(cells.slice(i, i + 7));
    }

    // Label a column with its month name the first time that month's 1st-of-month
    // appears in the grid (checking any row in the column, since the 1st can land on
    // any weekday).
    let lastMonth = -1;
    const monthMarkers = weeks.map((week) => {
      const firstOfMonth = week.find(
        (cell) => cell && parseUtcDate(cell.date).getUTCDate() <= 7
      );
      if (!firstOfMonth) return null;
      const month = parseUtcDate(firstOfMonth.date).getUTCMonth();
      if (month === lastMonth) return null;
      lastMonth = month;
      return MONTH_LABELS[month];
    });

    return { weeks, monthMarkers, totalActive: nonZero.length };
  }, [data]);

  return (
    <div className="activity-heatmap">
      <div className="activity-heatmap-scroll">
        <div className="activity-heatmap-months">
          {monthMarkers.map((label, i) => (
            <span key={i} className="activity-heatmap-month">
              {label ?? ''}
            </span>
          ))}
        </div>
        <div className="activity-heatmap-body">
          <div className="activity-heatmap-day-labels">
            {DAY_LABELS.map((label, i) => (
              <span
                key={label}
                className={i % 2 === 0 ? '' : 'activity-heatmap-day-hidden'}
              >
                {i % 2 === 1 ? label : ''}
              </span>
            ))}
          </div>
          <div className="activity-heatmap-grid">
            {weeks.map((week, wi) => (
              <div className="activity-heatmap-week" key={wi}>
                {week.map((cell, di) =>
                  cell ? (
                    <span
                      key={di}
                      className={`activity-heatmap-cell activity-heatmap-level-${cell.level}`}
                      title={`${cell.count} activity event${cell.count === 1 ? '' : 's'} on ${formatDisplayDate(cell.date)}`}
                    />
                  ) : (
                    <span
                      key={di}
                      className="activity-heatmap-cell activity-heatmap-cell-spacer"
                    />
                  )
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="activity-heatmap-footer">
        <span>
          {totalActive} active day{totalActive === 1 ? '' : 's'} in the last
          year
        </span>
        <div className="activity-heatmap-legend">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span
              key={level}
              className={`activity-heatmap-cell activity-heatmap-level-${level}`}
            />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}
