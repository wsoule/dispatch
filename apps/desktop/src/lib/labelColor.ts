import { labelColorIndex } from '@dispatch-foo/core/browser';
import type { LabelDefinition } from '@dispatch-foo/core/browser';

import { colorForLabel as hashedColorForLabel } from '@/ui/ai/list-format';

// A label chip's color: the project's label registry (config `labels:`, synced
// from Linear) when it names one, else the hue the component library hashes
// from the name, so a pill in a records table and one on a task card agree.
// The registry lands as custom properties on the document root, so a memoized
// row repaints when it loads without re-rendering.

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

/** The color a chip draws for `label`: the registry's, else the hashed hue. */
export function colorForLabel(label: string): string {
  return `var(${labelVar(label)}, ${hashedColorForLabel(label)})`;
}

let applied = new Set<string>();

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
  for (const name of applied) {
    if (!next.has(name)) root.style.removeProperty(name);
  }
  for (const [name, color] of next) root.style.setProperty(name, color);
  applied = new Set(next.keys());
}
