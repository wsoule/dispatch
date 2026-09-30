import { DEFAULT_STATUS_MODEL, statusModelOf } from '@dispatch/core/browser';
import type { StatusModel } from '@dispatch/core/browser';
import { useMemo, useSyncExternalStore } from 'react';

// The open project's status types and lifecycle roles, held at module level
// (like notifications.ts's toggles) for leaf components with no config at hand,
// which subscribe via useActiveStatusModel. useDispatchProject sets it in a layout
// effect after the render that carries config, so a view holding config derives
// its own with useStatusModelOf rather than read this inside a memo.
let active: StatusModel = DEFAULT_STATUS_MODEL;
const listeners = new Set<() => void>();

export function activeStatusModel(): StatusModel {
  return active;
}

/** Null (config still loading) resets to the built-in model. */
export function setActiveStatusModel(model: StatusModel | null): void {
  const next = model ?? DEFAULT_STATUS_MODEL;
  if (next === active) return;
  active = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The open project's model, re-rendering the caller when it changes — so a memoized
 * card drawn before config loaded still redraws its glyph once it does. */
export function useActiveStatusModel(): StatusModel {
  return useSyncExternalStore(subscribe, activeStatusModel);
}

/** `config`'s model, in the render that carries it: what a view holding config passes to
 * its memos, since the module-level model is set in an effect after that render. Null or
 * undefined (still loading) is the built-in model. */
export function useStatusModelOf(
  config: Parameters<typeof statusModelOf>[0]
): StatusModel {
  return useMemo(() => statusModelOf(config), [config]);
}
