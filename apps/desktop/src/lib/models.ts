// The Claude models a run can be dispatched with, and the user's default choice. The default
// is persisted in localStorage (this is a Tauri/browser-only app) so it survives restarts the
// same way the board's List/Board toggle does; the picker in Settings writes it, and every
// dispatch reads it unless a per-dispatch override is given.

export interface ModelOption {
  /** SDK model id passed straight through to the Agent SDK's `query({ options: { model } })`. */
  id: string;
  label: string;
  /** One-line "when to reach for this" hint shown in the Settings picker. */
  hint: string;
}

export const MODELS: ModelOption[] = [
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    hint: 'Most capable Opus — the default for real work',
  },
  {
    id: 'claude-fable-5',
    label: 'Fable 5',
    hint: "Anthropic's most capable model — hardest long-horizon work (premium pricing)",
  },
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    hint: 'Previous-generation Opus',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    hint: 'Faster and cheaper for well-scoped tasks',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    hint: 'Fastest — small mechanical changes',
  },
];

export const DEFAULT_MODEL = MODELS[0].id;

const STORAGE_KEY = 'dispatch:default-model';

// The user's chosen default dispatch model, or the built-in default. Guarded for a missing
// `localStorage` (never throws) and validated against the known list so a stale/removed id
// can't leave dispatch pointed at a model that no longer exists.
export function readDefaultModel(): string {
  if (typeof window === 'undefined') return DEFAULT_MODEL;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored !== null && MODELS.some((m) => m.id === stored)
    ? stored
    : DEFAULT_MODEL;
}

export function writeDefaultModel(id: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, id);
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
