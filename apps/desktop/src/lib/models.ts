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
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    hint: 'Most capable — the default for real work',
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
