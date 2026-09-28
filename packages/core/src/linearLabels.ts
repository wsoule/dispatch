// Linear's labels as the project's label registry: each label becomes (or is
// matched to) a `labels:` entry carrying `external: linear:<id>`, and colors
// travel both ways against a per-label base. Pure: no node:* imports.
import type { LabelDefinition } from './labels.js';
import { labelRef } from './labels.js';
import type { LinearLabel } from './linearMap.js';

const LABEL_PREFIX = 'linear:';

/** The `LabelDefinition.external` value for a Linear label. */
export function linearLabelExternal(labelId: string): string {
  return `${LABEL_PREFIX}${labelId}`;
}

/** A color to write to one Linear label. */
export interface LabelColorPush {
  id: string;
  color: string;
}

export interface LabelSyncInput {
  /** `labels:` as configured (what gets rewritten). */
  configured: readonly LabelDefinition[];
  /** The linked teams' labels plus the workspace's, primary team first. */
  linear: readonly LinearLabel[];
  /** Linear label id -> the color both sides held after the last sync. */
  base: Readonly<Record<string, string | null>>;
  mayPull: boolean;
  mayPush: boolean;
}

export interface LabelSyncResult {
  /** The new `labels:` list: existing entries in place, new ones appended. */
  configured: LabelDefinition[];
  changed: boolean;
  /** Local color edits to write to Linear. */
  push: LabelColorPush[];
  /** The next base, assuming every push lands. */
  base: Record<string, string | null>;
}

function sameLabel(
  a: LabelDefinition,
  b: LabelDefinition | undefined
): boolean {
  return (
    b !== undefined &&
    a.name === b.name &&
    a.color === b.color &&
    (a.group ?? null) === (b.group ?? null) &&
    (a.external ?? null) === (b.external ?? null)
  );
}

/**
 * Folds Linear's labels into the registry. A label keeps (or claims, by ref)
 * its entry, whose name and group follow Linear. Colors merge three-way: a
 * local edit Linear has not moved on from is pushed; otherwise Linear's color
 * wins, including on first contact. Two Linear labels spelling the same ref
 * (one per team) share nothing: the first claims the entry. An entry whose
 * label is gone from Linear keeps its color and loses its link. The registry
 * holds one entry per ref, so a label renamed onto another entry's ref folds
 * in an unlinked (or orphaned) one, and yields to one another label spells.
 */
export function syncLinearLabels(input: LabelSyncInput): LabelSyncResult {
  const configured = input.configured.map((l) => ({ ...l }));
  const byExternal = new Map<string, number>();
  const byRef = new Map<string, number>();
  configured.forEach((l, i) => {
    if (l.external != null) byExternal.set(l.external, i);
    byRef.set(labelRef(l).toLowerCase(), i);
  });
  // The ref each Linear label spells as of this pass.
  const spelled = new Map(
    input.linear.map((l) => [
      linearLabelExternal(l.id),
      labelRef(l).toLowerCase(),
    ])
  );
  const claimed = new Set<number>();
  const absorbed = new Set<number>();
  const live = new Set<string>();
  // Re-keys entry `at` to `ref`; false when another label keeps that ref.
  const moveTo = (at: number, ref: string): boolean => {
    const other = byRef.get(ref);
    if (other !== undefined && other !== at) {
      const ext = configured[other].external ?? null;
      const holder = ext === null ? undefined : spelled.get(ext);
      const foreign = ext !== null && !ext.startsWith(LABEL_PREFIX);
      if (claimed.has(other) || holder === ref || foreign) return false;
      if (holder === undefined) {
        absorbed.add(other);
        configured[at].color ??= configured[other].color;
      }
    }
    const was = labelRef(configured[at]).toLowerCase();
    if (byRef.get(was) === at) byRef.delete(was);
    byRef.set(ref, at);
    return true;
  };
  const push: LabelColorPush[] = [];
  const base: Record<string, string | null> = {};

  for (const label of input.linear) {
    const external = linearLabelExternal(label.id);
    const ref = labelRef(label).toLowerCase();
    let at = byExternal.get(external);
    if (at === undefined) {
      const sameRef = byRef.get(ref);
      const free =
        sameRef !== undefined &&
        (configured[sameRef].external ?? null) === null;
      at = free ? sameRef : undefined;
      if (sameRef !== undefined && !free) continue;
    }
    if (at !== undefined && (claimed.has(at) || !moveTo(at, ref))) continue;
    live.add(external);
    const remote = label.color ?? null;
    if (at === undefined) {
      configured.push({
        name: label.name,
        color: remote,
        group: label.group ?? null,
        external,
      });
      at = configured.length - 1;
      byRef.set(ref, at);
      claimed.add(at);
      base[label.id] = remote;
      continue;
    }
    claimed.add(at);
    const entry = configured[at];
    entry.name = label.name;
    entry.group = label.group ?? null;
    entry.external = external;
    const local = entry.color;
    const was = input.base[label.id];
    // A local color Linear has not moved from is an edit; with no base, only
    // a push-only project reads it as one (Linear's wins where it may pull).
    const edited =
      local !== null && (was === undefined ? !input.mayPull : remote === was);
    if (local === remote) {
      base[label.id] = remote;
    } else if (!edited) {
      // No local color, first contact, or Linear moved: Linear's color wins.
      if (input.mayPull) {
        entry.color = remote;
        base[label.id] = remote;
      } else if (was !== undefined) {
        base[label.id] = was;
      }
    } else if (input.mayPush) {
      push.push({ id: label.id, color: local });
      base[label.id] = local;
    } else if (was !== undefined) {
      base[label.id] = was;
    }
  }

  const kept = configured.filter((_, i) => !absorbed.has(i));
  for (const entry of kept) {
    const ext = entry.external ?? null;
    if (ext !== null && ext.startsWith(LABEL_PREFIX) && !live.has(ext)) {
      entry.external = null;
    }
  }
  const changed =
    kept.length !== input.configured.length ||
    kept.some((l, i) => !sameLabel(l, input.configured[i]));
  return { configured: kept, changed, push, base };
}
