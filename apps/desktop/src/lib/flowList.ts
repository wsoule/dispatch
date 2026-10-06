import { useEffect, useRef, useState } from 'react';

/** One row of a flow column: still there, or on its way out. */
export interface FlowRow<T> {
  key: string;
  item: T;
  leaving: boolean;
}

/**
 * The rows to draw: every current item, then each item that just left, kept
 * for its exit animation. A key that comes back is current again, not leaving.
 */
export function flowRows<T>(
  current: readonly T[],
  keyOf: (item: T) => string,
  leaving: ReadonlyMap<string, T>
): FlowRow<T>[] {
  const rows = current.map((item) => ({
    key: keyOf(item),
    item,
    leaving: false,
  }));
  const present = new Set(rows.map((r) => r.key));
  for (const [key, item] of leaving) {
    if (!present.has(key)) rows.push({ key, item, leaving: true });
  }
  return rows;
}

/** How long a departed row stays for its exit animation. */
export const LEAVE_MS = 450;

/** `items` as flow rows: anything that drops out stays `leaving` for LEAVE_MS. */
export function useFlowRows<T>(
  items: readonly T[],
  keyOf: (item: T) => string
): FlowRow<T>[] {
  const previous = useRef(new Map<string, T>());
  const latest = useRef(items);
  latest.current = items;
  const keyOfRef = useRef(keyOf);
  keyOfRef.current = keyOf;
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [leaving, setLeaving] = useState<ReadonlyMap<string, T>>(new Map());
  // Callers rebuild their lists every render; only a change in who is listed counts.
  const keys = items.map(keyOf).join('\n');

  useEffect(() => {
    const now = new Map(
      latest.current.map((item) => [keyOfRef.current(item), item])
    );
    const gone = [...previous.current].filter(([key]) => !now.has(key));
    previous.current = now;
    if (gone.length === 0) return;
    setLeaving((prev) => new Map([...prev, ...gone]));
    // Each departure runs out on its own; a later change never cancels it.
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setLeaving((prev) => {
        const next = new Map(prev);
        for (const [key] of gone) next.delete(key);
        return next;
      });
    }, LEAVE_MS);
    timers.current.add(timer);
  }, [keys]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);

  return flowRows(items, keyOf, leaving);
}
