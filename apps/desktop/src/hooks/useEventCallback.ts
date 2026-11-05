import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * A function that keeps one identity for the life of the component and always
 * runs the latest render's `fn`: for callbacks a memoized row calls on an
 * event (a menu choice, a drop, a click), so that passing them never redraws
 * the row. The host may pass a fresh inline handler on every render; the ref
 * is synced in a layout effect, before any event of the new render can fire.
 */
export function useEventCallback<A extends unknown[], R>(
  fn: (...args: A) => R
): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
