import { useEffect, useState } from 'react';

/** How often the minute clock may move. */
const CLOCK_TICK_MS = 60_000;

/** Now, truncated to the minute. */
function currentMinute(): number {
  return Math.floor(Date.now() / CLOCK_TICK_MS) * CLOCK_TICK_MS;
}

/**
 * The current minute, advanced by a 60 s ticker. A primitive, so whatever
 * reads it (the planning's "today" and "stalled", the Runs page's relative
 * times) recomputes at most once a minute: the ticker re-renders only when the
 * minute moved, never on every render.
 */
export function useMinuteClock(): number {
  const [minute, setMinute] = useState(currentMinute);
  useEffect(() => {
    const id = setInterval(() => setMinute(currentMinute()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return minute;
}
