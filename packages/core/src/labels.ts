// The project's label registry: a color (and an external link) per label a
// task can carry, so a chip draws the color Linear shows instead of a hash.
// Pure: no node:* imports.
import { describeValue } from './describe.js';

export interface LabelDefinition {
  /** The label's own name; inside a group, the part after `Group/`. */
  name: string;
  /** `#rgb` or `#rrggbb`, or null to let the UI pick one. */
  color: string | null;
  /** The group label's name, for a label nested in a group. */
  group?: string | null;
  /** The id in an external tracker (`linear:<label-uuid>`), or null. */
  external?: string | null;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Whether `value` is a color the registry stores (hex, so it is safe in CSS). */
export function isLabelColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

/** A label as a task spells it: `Group/Name` inside a group, else the name. */
export function labelRef(label: {
  name: string;
  group?: string | null;
}): string {
  return label.group == null || label.group === ''
    ? label.name
    : `${label.group}/${label.name}`;
}

/** Why `value` is not a valid `labels:` entry, or null when it is. */
export function labelDefinitionError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'expected a map';
  const l = value as Record<string, unknown>;
  if (typeof l.name !== 'string' || l.name.trim() === '') {
    return 'name must be a non-empty string';
  }
  if (l.color != null && !isLabelColor(l.color)) {
    return `color ${describeValue(l.color)} must be a hex color like #5e6ad2`;
  }
  for (const key of ['group', 'external'] as const) {
    if (l[key] != null && typeof l[key] !== 'string') {
      return `${key} must be a string`;
    }
  }
  return null;
}

/** Lowercased label ref -> color, for the labels that have one. */
export function labelColorIndex(
  labels: readonly LabelDefinition[]
): Map<string, string> {
  const out = new Map<string, string>();
  for (const label of labels) {
    if (label.color === null) continue;
    out.set(labelRef(label).toLowerCase(), label.color);
  }
  return out;
}

/**
 * The registry with `ref`'s color set: an existing entry (matched
 * case-insensitively) is recolored, a new one is appended. Clearing the color
 * of an entry no tracker links drops the entry, since it says nothing else.
 */
export function withLabelColor(
  labels: readonly LabelDefinition[],
  ref: string,
  color: string | null
): LabelDefinition[] {
  const key = ref.trim().toLowerCase();
  const at = labels.findIndex((l) => labelRef(l).toLowerCase() === key);
  if (at < 0) {
    return color === null
      ? [...labels]
      : [...labels, { name: ref.trim(), color, group: null, external: null }];
  }
  const out = labels.map((l) => ({ ...l }));
  if (color === null && (out[at].external ?? null) === null) {
    out.splice(at, 1);
  } else {
    out[at].color = color;
  }
  return out;
}
