import type { AuthTier } from '@dispatch/client';
import { useCallback, useSyncExternalStore } from 'react';

/** Features you opt into on this machine before they become the default. */
export const BETA_FEATURES = [
  {
    id: 'two-views',
    label: 'Two views',
    description:
      'Replace the sidebar with two views, Overseer and Tasks, plus a settings link.',
  },
] as const;

export type BetaFeature = (typeof BETA_FEATURES)[number]['id'];

export const BETA_STORAGE_KEY = 'dispatch:beta';

const KNOWN = new Set<string>(BETA_FEATURES.map((f) => f.id));

export function parseBetaFlags(stored: string | null): Set<BetaFeature> {
  if (stored === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter(
        (f): f is BetaFeature => typeof f === 'string' && KNOWN.has(f)
      )
    );
  } catch {
    return new Set();
  }
}

// One in-memory copy so a blocked localStorage still keeps a choice for the session.
let flags: Set<BetaFeature> | null = null;
const listeners = new Set<() => void>();

function current(): Set<BetaFeature> {
  if (flags === null) {
    try {
      flags = parseBetaFlags(window.localStorage.getItem(BETA_STORAGE_KEY));
    } catch {
      flags = new Set();
    }
  }
  return flags;
}

export function isBetaOn(feature: BetaFeature): boolean {
  return current().has(feature);
}

export function setBetaFlag(feature: BetaFeature, on: boolean): void {
  const next = new Set(current());
  if (on) next.add(feature);
  else next.delete(feature);
  flags = next;
  try {
    window.localStorage.setItem(BETA_STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // Kept in memory for this session.
  }
  for (const listener of listeners) listener();
}

export function subscribeBeta(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One beta flag as state, shared by every component that reads it. */
export function useBetaFlag(
  feature: BetaFeature
): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribeBeta, () => isBetaOn(feature));
  const set = useCallback(
    (next: boolean) => setBetaFlag(feature, next),
    [feature]
  );
  return [on, set];
}

/** A team-local page offers Two views to its operator only, until owned conversations ship. */
export function twoViewsAllowed(context: {
  teamLocal: boolean;
  tier: AuthTier | null;
}): boolean {
  return !context.teamLocal || context.tier === 'operator';
}
