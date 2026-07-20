import './ActivityBars.css';

interface ActivityBarsProps {
  /** Daily counts, any length — oldest first. Caller decides the window (e.g. 14 days). */
  data: number[];
}

/**
 * Small decorative sparkline: one vertical bar per entry in `data`, height scaled relative to
 * the max value in the array. Renders the bar row shape even for an empty or all-zero array
 * (every bar at minimum height) rather than hiding — "no visible activity" is itself useful
 * information at a glance, not an error state to suppress.
 */
export function ActivityBars({ data }: ActivityBarsProps) {
  const max = Math.max(0, ...data);

  return (
    <div className="activity-bars" title="commits over the last 14 days">
      {data.map((count, i) => {
        const heightPct = max > 0 ? Math.max((count / max) * 100, 12) : 12;
        return (
          <span
            key={i}
            className="activity-bar"
            style={{ height: `${heightPct}%` }}
          />
        );
      })}
    </div>
  );
}
