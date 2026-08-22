import { useEffect, useRef, useState } from 'react';

/** Formats a duration in milliseconds as `m:ss`, switching to `h:mm:ss` once it
 * reaches an hour. Minutes stay unpadded so short runs read as "0:07", not "00:07". */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/** Ticks a formatted elapsed-time string once a second. `startedAt` is an epoch-ms
 * timestamp; when omitted, the clock starts counting from when the hook first mounted
 * so a caller that doesn't know a precise start time still gets a running indicator. */
export function useElapsed(startedAt?: number): string {
  const [now, setNow] = useState(() => Date.now());
  const startRef = useRef(startedAt ?? now);

  useEffect(() => {
    if (startedAt !== undefined) startRef.current = startedAt;
  }, [startedAt]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  return formatElapsed(now - startRef.current);
}
