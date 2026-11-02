import { labelColorIndex } from '@dispatch-foo/core/browser';
import type { LabelDefinition } from '@dispatch-foo/core/browser';
import { type AvatarHue, avatarHue } from '@dispatch/ui';

// A label's color: the project's label registry (config `labels:`, synced
// from Linear) when it names one, else a decorative hue hashed from the name
// (the library's `avatarHue`: violet, teal, rose or orange, never a status
// hue). The registry lands as custom properties on the document root, so a
// memoized row that paints `colorForLabel` repaints when it loads without
// re-rendering; a component that needs the hex itself (a Chip's swatch mark)
// reads `labelHex` and re-renders through `subscribeLabelColors`.

// The custom property holding one label's registry color. Labels match
// case-insensitively, the way the Linear sync matches them.
function labelVar(label: string): string {
  const key = label.toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `--label-color-${hash.toString(36)}`;
}

// The decorative fallback per hue, spelled out so every var name is a literal.
const HUE_COLOR: Readonly<Record<AvatarHue, string>> = {
  violet: 'var(--violet)',
  teal: 'var(--teal)',
  rose: 'var(--rose)',
  orange: 'var(--orange)',
};

/** The color a chip draws for `label`: the registry's, else the hashed
 * decorative hue. */
export function colorForLabel(label: string): string {
  return `var(${labelVar(label)}, ${HUE_COLOR[avatarHue(label)]})`;
}

/** The label registry's colors as last applied: an immutable snapshot, replaced
 * (a new object) on every `applyLabelColors`, so `useSyncExternalStore` sees
 * the change and a memo can depend on it. */
export interface LabelColors {
  /** The registry's hex for `label` (matched case-insensitively), or
   * undefined when the registry has no color for it. */
  hex(label: string): string | undefined;
}

function snapshotOf(byVar: ReadonlyMap<string, string>): LabelColors {
  return { hex: (label) => byVar.get(labelVar(label)) };
}

// The applied registry (custom property name -> hex), its snapshot and the
// components waiting on it.
let registry = new Map<string, string>();
let snapshot = snapshotOf(registry);
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
 * them). The registry only holds hex colors, so every value is safe CSS.
 */
export function applyLabelColors(
  labels: readonly LabelDefinition[] | null,
  root: HTMLElement = document.documentElement
): void {
  const next = new Map<string, string>();
  for (const [ref, color] of labelColorIndex(labels ?? [])) {
    next.set(labelVar(ref), color);
  }
  for (const name of registry.keys()) {
    if (!next.has(name)) root.style.removeProperty(name);
  }
  for (const [name, color] of next) root.style.setProperty(name, color);
  registry = next;
  snapshot = snapshotOf(next);
  for (const listener of listeners) listener();
}
