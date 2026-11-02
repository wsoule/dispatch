import { labelColorIndex } from '@dispatch-foo/core/browser';
import type { LabelDefinition } from '@dispatch-foo/core/browser';

// A label's registry color: the project's label registry (config `labels:`,
// synced from Linear) names a hex for some labels. A component that draws a
// label's swatch (LabelChip, a board card's label picker) reads it through
// `labelColors` and re-renders through `subscribeLabelColors` when the
// registry loads or changes; a label the registry has no color for draws a
// decorative hue hashed from its name (the library's `avatarHue`) instead.

// The registry's key for one label. Labels match case-insensitively, the way
// the Linear sync matches them.
function labelKey(label: string): string {
  return label.toLowerCase();
}

/** The label registry's colors as last applied: an immutable snapshot, replaced
 * (a new object) on every `applyLabelColors`, so `useSyncExternalStore` sees
 * the change and a memo can depend on it. */
export interface LabelColors {
  /** The registry's hex for `label` (matched case-insensitively), or
   * undefined when the registry has no color for it. */
  hex(label: string): string | undefined;
}

function snapshotOf(byKey: ReadonlyMap<string, string>): LabelColors {
  return { hex: (label) => byKey.get(labelKey(label)) };
}

// The applied registry's snapshot (lowercased label -> hex inside) and the
// components waiting on it.
let snapshot = snapshotOf(new Map());
const listeners = new Set<() => void>();

/** The registry's hex for `label` (matched case-insensitively), or undefined
 * when the registry has no color for it (or has not loaded). */
export function labelHex(label: string): string | undefined {
  return snapshot.hex(label);
}

/** The current snapshot: what a component reads with `useSyncExternalStore`
 * (with `subscribeLabelColors`) to repaint its swatches when it changes. */
export function labelColors(): LabelColors {
  return snapshot;
}

/** Calls `onChange` after every `applyLabelColors`; returns the unsubscribe. */
export function subscribeLabelColors(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * Publishes the open project's label colors (null while config loads clears
 * them) to every subscriber. The registry only holds hex colors.
 */
export function applyLabelColors(
  labels: readonly LabelDefinition[] | null
): void {
  const next = new Map<string, string>();
  for (const [ref, color] of labelColorIndex(labels ?? [])) {
    next.set(labelKey(ref), color);
  }
  snapshot = snapshotOf(next);
  for (const listener of listeners) listener();
}
