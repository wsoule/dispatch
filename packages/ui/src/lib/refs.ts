import { type Ref, type RefCallback, useCallback } from 'react';

/** Sets a ref of any kind (a callback or an object) to `value`. */
function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') {
    ref(value);
  } else if (ref !== null && ref !== undefined) {
    ref.current = value;
  }
}

/**
 * One callback ref feeding two refs: a component's own (it needs the
 * element: a Popover's trigger, a Tooltip's anchor) and the one a host
 * already put on the element it handed in, so cloning that element with
 * the component's ref never takes the host's away.
 */
export function useMergedRef<T>(
  own: { current: T | null },
  host: Ref<T> | undefined
): RefCallback<T> {
  return useCallback(
    (node: T | null) => {
      own.current = node;
      assignRef(host, node);
    },
    [own, host]
  );
}
