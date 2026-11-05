'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import type { ErrorFormatter, SaveResult } from './types';

// Layout effects do nothing on the server; this keeps React quiet there.
const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** A ref that always holds the latest render's `value`, for event handlers
    and timers that must not capture a stale one. Updated after each commit
    (never written during render). */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useClientLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** The sentence printed for a rejected save: the Error's message, a thrown
    string, or `fallback` when the rejection says nothing useful. */
export function saveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }
  if (typeof error === 'string' && error.trim() !== '') return error;
  return fallback;
}

/** A comparable key for a control's value. Lists compare as sets, so a
    host that returns the same labels in another order counts as
    unchanged. */
export function valueKey(value: unknown): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value.map((item) => String(item)).sort());
  }
  return JSON.stringify(value ?? null);
}

export interface SaveControl<T> {
  /** What the control shows: the value being saved (or just saved), else
      the host's value. */
  shown: T;
  /** The latest save is in flight. */
  pending: boolean;
  /** The latest save was rejected: its message. */
  error: string | null;
  /** Saves `next`; resolves true once stored, false when rejected (or
      overtaken by a newer save). */
  save: (next: T) => Promise<boolean>;
  clearError: () => void;
}

interface Optimistic<T> {
  value: T;
  /** valueKey of the host's value when the save started. */
  base: string;
}

/**
 * The family's save contract in one hook. `save(next)` shows `next` at once
 * (pending), calls the host's callback, and then:
 * - on resolve, keeps showing `next` until the host's `value` changes (a
 *   host that refreshes a moment later never flickers back);
 * - on rejection, drops `next` (the host's value shows again: the
 *   rollback) and records the error message.
 * Only the latest save counts: an older one settling late changes nothing.
 * Once the host's value moves off the value the save started from, the
 * host wins, whatever is in flight.
 */
export function useSaveControl<T>(
  value: T,
  onSave: (next: T) => SaveResult,
  formatError: ErrorFormatter | undefined,
  fallbackMessage: string,
  /** false: drop the saved value as soon as the save resolves (an action
      such as "link this task", where the host's value never changes). */
  keepAfterSave = true
): SaveControl<T> {
  const key = valueKey(value);
  // Read at call time, so `save` keeps one identity across renders.
  const latest = useLatest({
    key,
    onSave,
    formatError,
    fallbackMessage,
    keepAfterSave,
  });
  const seq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [optimistic, setOptimistic] = useState<Optimistic<T> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The host's value moved on (the save landed, or someone else changed
  // it): forget the optimistic copy for good, so the value coming back to
  // the old one later is not mistaken for this save.
  if (optimistic !== null && optimistic.base !== key) setOptimistic(null);

  const save = useCallback(
    (next: T): Promise<boolean> => {
      seq.current += 1;
      const id = seq.current;
      const current = latest.current;
      setOptimistic({ value: next, base: current.key });
      setPending(true);
      setError(null);
      let result: SaveResult;
      try {
        result = current.onSave(next);
      } catch (thrown) {
        result = Promise.reject(thrown);
      }
      return Promise.resolve(result).then(
        () => {
          if (mounted.current && id === seq.current) {
            setPending(false);
            if (!latest.current.keepAfterSave) setOptimistic(null);
          }
          return id === seq.current;
        },
        (rejection: unknown) => {
          if (!mounted.current || id !== seq.current) return false;
          const format = latest.current.formatError;
          setPending(false);
          setOptimistic(null);
          setError(
            format !== undefined
              ? format(rejection)
              : saveErrorMessage(rejection, latest.current.fallbackMessage)
          );
          return false;
        }
      );
    },
    [latest]
  );

  const clearError = useCallback(() => setError(null), []);

  const live = optimistic !== null && optimistic.base === key;
  return {
    shown: live ? optimistic.value : value,
    pending,
    error,
    save,
    clearError,
  };
}
