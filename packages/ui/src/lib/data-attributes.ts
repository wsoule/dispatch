import type { DataAttributes } from '../types';

function isDataKey(key: string): key is `data-${string}` {
  return key.startsWith('data-');
}

/** The `data-*` entries of a component's props (a host's `data-testid`
    and `data-slot` hooks, typed as DataAttributes), to spread on the
    component's root element. Everything else is left out, so a component
    can pass its whole props object without leaking its own props into
    the DOM. */
export function dataAttributes(props: object): DataAttributes {
  const out: DataAttributes = {};
  for (const [key, value] of Object.entries(props)) {
    if (isDataKey(key)) out[key] = value;
  }
  return out;
}
