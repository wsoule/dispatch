// The Claude models a run can be dispatched with. localStorage here holds only
// a per-device override of the project's `.dispatch/config.yml` default.

import { EFFORT_LEVELS, isEffortLevel } from '@dispatch/core/browser';
import type { EffortLevel } from '@dispatch/core/browser';

export interface ModelOption {
  /** SDK model id passed straight through to the Agent SDK's `query({ options: { model } })`. */
  id: string;
  label: string;
}

// The default for real work first; Fable is the hardest-work premium tier, Sonnet the
// faster/cheaper pick for well-scoped tasks, Haiku the fastest for small mechanical changes.
export const MODELS: ModelOption[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
];

const DEFAULT_MODEL = MODELS[0].id;

const STORAGE_KEY = 'dispatch:default-model';

// Reads the user's per-device model override, if one is stored and is still a
// valid choice. Never throws when `localStorage` is missing (SSR/tests).
function readStoredOverride(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored !== null && MODELS.some((m) => m.id === stored)
    ? stored
    : undefined;
}

// The user's chosen default dispatch model, or the built-in one. Seeds the
// picker; see resolveExecuteModel for what a dispatch actually runs on.
export function readDefaultModel(): string {
  return readStoredOverride() ?? DEFAULT_MODEL;
}

// The model a dispatch actually runs on: the per-device override if set, else
// the project's configured `models.execute`, else the hardcoded default.
export function resolveExecuteModel(
  config: { models?: { execute?: string } } | null | undefined
): string {
  return readStoredOverride() ?? config?.models?.execute ?? DEFAULT_MODEL;
}

/** The config roles whose composer offers a per-conversation model pick. */
export type PickableRole = 'plan' | 'overseer';

// Per-device storage key for one role's remembered pick.
function roleStorageKey(role: PickableRole): string {
  return `dispatch:model:${role}`;
}

// The model the user last picked for `role` on this device, if it is still a
// valid choice. Never throws when `localStorage` is missing (SSR/tests) or
// refuses access (a private window).
export function readRoleModelOverride(role: PickableRole): string | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    const stored = window.localStorage.getItem(roleStorageKey(role));
    return stored !== null && MODELS.some((m) => m.id === stored)
      ? stored
      : undefined;
  } catch {
    return undefined;
  }
}

// Remembers a composer pick for `role` on this device, so "always Fable for
// planning" sticks without a trip to Settings. Best-effort: a storage failure
// only costs the memory, not the pick itself.
export function storeRoleModelOverride(role: PickableRole, id: string): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(roleStorageKey(role), id);
  } catch {
    // Nothing to do: the caller still holds the pick in state.
  }
}

// The model a plan or overseer conversation opens on when the composer has
// not been touched: the device's remembered pick for the role, else the
// project's configured model for it, else the built-in default.
export function resolveRoleModel(
  role: PickableRole,
  config: { models?: Partial<Record<PickableRole, string>> } | null | undefined
): string {
  return readRoleModelOverride(role) ?? config?.models?.[role] ?? DEFAULT_MODEL;
}

// A short human label for a model id (for run headers/session), falling back to the raw id so
// an unknown/older model still shows something meaningful.
export function modelLabel(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  return MODELS.find((m) => m.id === id)?.label ?? id;
}

// Display labels for model ids that appear in *ingested analytics* but aren't in the dispatch
// picker `MODELS` — older generations still present in historical sessions, plus Claude Code's
// non-billable `<synthetic>` sentinel. Kept beside `MODELS` so all id→label mapping lives in
// one file, per the parser's "map raw ids to display names in one place" note.
const HISTORICAL_MODEL_LABELS: Record<string, string> = {
  'claude-opus-5': 'Opus 5',
  'claude-fable-5': 'Fable 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  '<synthetic>': 'Synthetic',
};

// Human-readable name for any model id seen in analytics (session rows, per-model spend), not
// just the dispatchable ones. Resolution order: exact `MODELS` match, exact historical match,
// then longest-prefix match against known ids so a dated/versioned suffix (e.g.
// `claude-opus-5-20260115`) still resolves to its family label. Falls back to the raw id, and
// returns undefined only for a missing/undefined id so callers can show "unknown model".
export function modelDisplayName(
  id: string | null | undefined
): string | undefined {
  if (id === undefined || id === null) return undefined;
  const exact =
    MODELS.find((m) => m.id === id)?.label ?? HISTORICAL_MODEL_LABELS[id];
  if (exact !== undefined) return exact;

  const known: { id: string; label: string }[] = [
    ...MODELS.map((m) => ({ id: m.id, label: m.label })),
    ...Object.entries(HISTORICAL_MODEL_LABELS).map(([mid, label]) => ({
      id: mid,
      label,
    })),
  ];
  const prefix = known
    .filter((m) => id.startsWith(m.id))
    .sort((a, b) => b.id.length - a.id.length)[0];
  return prefix?.label ?? id;
}

// The effort picker's sentinel for "send nothing": the server then applies the
// config's effort for the role, or the model's own default.
export const DEFAULT_EFFORT_ID = 'default';

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

// Picker choices: "Default" first (naming the configured level when there is
// one, so the user sees what they would get), then the five SDK levels.
export function effortOptions(
  configured: EffortLevel | undefined
): { id: string; label: string }[] {
  return [
    {
      id: DEFAULT_EFFORT_ID,
      label:
        configured === undefined
          ? 'Default'
          : `Default (${EFFORT_LABELS[configured]})`,
    },
    ...EFFORT_LEVELS.map((level) => ({
      id: level,
      label: EFFORT_LABELS[level],
    })),
  ];
}

// The level a picker id stands for; the "Default" sentinel (or anything
// unrecognised) is undefined, meaning no effort is sent.
export function effortFromId(id: string): EffortLevel | undefined {
  return isEffortLevel(id) ? id : undefined;
}
