// Field-level three-way merge between a task and its Linear record. Pure: no
// node:* imports.
//
// Both sides are first projected into one canonical value space (Linear ids,
// sorted sets, normalized markdown). The base keeps a hash per field for EACH
// side as of the last sync, so a mapping that cannot represent a value exactly
// (a sub-issue's inherited project, a paused project status) never reads as a
// change on the next pass.
import { resolveConflict } from './linearMap.js';

/** A projected value no Linear field can hold (an agent assignee): never pushed. */
export const UNMAPPED = '\u0000unmapped';

/** One side's canonical values, by field name. */
export type FieldValues = Readonly<Record<string, unknown>>;

/** Per-field hashes as of the last successful sync, one map per side. */
export interface FieldBase {
  local: Record<string, string>;
  remote: Record<string, string>;
}

/**
 * What to do with one field:
 * - `push`: write the local value to Linear.
 * - `pull`: write the remote value locally.
 * - `rebase`: nothing to write, but the base is stale (both sides already
 *   agree, or the only change is one this field ignores).
 */
export interface FieldDecision {
  field: string;
  action: 'push' | 'pull' | 'rebase';
  /** Both sides changed since the base; the newer timestamp won. */
  conflict: boolean;
}

// Deterministic JSON: object keys sorted, so equal values hash equally.
function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** A short, stable hash of a canonical value (FNV-1a 32-bit, base 36). */
export function fieldHash(value: unknown): string {
  const text = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** Every field's hash, for recording a base. */
export function hashFields(
  fields: readonly string[],
  values: FieldValues
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) out[field] = fieldHash(values[field]);
  return out;
}

export interface MergeInput {
  fields: readonly string[];
  local: FieldValues;
  remote: FieldValues;
  /** Null when the pair has never been synced field by field. */
  base: FieldBase | null;
  /** `TaskMeta.updated` and the record's `updatedAt`: the conflict tie-break. */
  localUpdated: string;
  remoteUpdated: string;
  /** Without a base: whether the task holds an edit no sync has sent yet. */
  localDirty: boolean;
  /** Fields Linear owns: a local change is ignored, never pushed. */
  pullOnly?: ReadonlySet<string>;
  /** Fields not trusted this pass (a cut-short list): skipped entirely. */
  unknown?: ReadonlySet<string>;
  /** Without a base, only these fields may push (default: all). The rest
   *  have no history to say the local value is an edit, so Linear's wins. */
  noBasePush?: ReadonlySet<string>;
  /** Fields whose local value is a placeholder Linear's can now replace:
   *  pulled, with no conflict, whatever the base says. */
  refresh?: ReadonlySet<string>;
}

/**
 * Decides every field of one task/record pair. Without a base (a link made
 * before field-level sync), a clean task takes the remote value and a dirty
 * one goes to whichever side is newer — the rule the whole-record sync used.
 */
export function mergeFields(input: MergeInput): FieldDecision[] {
  const decisions: FieldDecision[] = [];
  const wholeRecordWinner = resolveConflict(
    input.localUpdated,
    input.remoteUpdated
  );
  for (const field of input.fields) {
    if (input.unknown?.has(field) === true) continue;
    if (input.refresh?.has(field) === true) {
      decisions.push({ field, action: 'pull', conflict: false });
      continue;
    }
    const localValue = input.local[field];
    const lh = fieldHash(localValue);
    const rh = fieldHash(input.remote[field]);
    const baseL = input.base?.local[field];
    const baseR = input.base?.remote[field];
    const unmapped =
      localValue === UNMAPPED || input.pullOnly?.has(field) === true;
    if (lh === rh) {
      if (baseL !== lh || baseR !== rh) {
        decisions.push({ field, action: 'rebase', conflict: false });
      }
      continue;
    }
    if (input.base === null || baseL === undefined || baseR === undefined) {
      const contested =
        !unmapped && input.localDirty && (input.noBasePush?.has(field) ?? true);
      decisions.push({
        field,
        action: contested && wholeRecordWinner === 'local' ? 'push' : 'pull',
        conflict: contested,
      });
      continue;
    }
    const localChanged = !unmapped && baseL !== lh;
    const remoteChanged = baseR !== rh;
    if (!localChanged && !remoteChanged) {
      if (unmapped && baseL !== lh) {
        decisions.push({ field, action: 'rebase', conflict: false });
      }
      continue;
    }
    if (localChanged && !remoteChanged) {
      decisions.push({ field, action: 'push', conflict: false });
    } else if (!localChanged) {
      decisions.push({ field, action: 'pull', conflict: false });
    } else {
      // Both moved: the newer edit wins this field; a tie goes to Linear, the
      // copy teammates are looking at.
      decisions.push({
        field,
        action: wholeRecordWinner === 'local' ? 'push' : 'pull',
        conflict: true,
      });
    }
  }
  return decisions;
}

/**
 * The base to record after a pass: every field's hash from the values now on
 * each side, except fields whose write failed (or that were skipped), which
 * keep their old base so the next pass sees the same difference again.
 */
export function nextBase(
  fields: readonly string[],
  local: FieldValues,
  remote: FieldValues,
  previous: FieldBase | null,
  keep: ReadonlySet<string> = new Set()
): FieldBase {
  const next: FieldBase = {
    local: hashFields(fields, local),
    remote: hashFields(fields, remote),
  };
  for (const field of keep) {
    const oldL = previous?.local[field];
    const oldR = previous?.remote[field];
    if (oldL === undefined) delete next.local[field];
    else next.local[field] = oldL;
    if (oldR === undefined) delete next.remote[field];
    else next.remote[field] = oldR;
  }
  return next;
}
